"""The deliberately small NutFC protocol core.

This module uses Cashu/Nutshell's blind-DHKE primitives for the credential
signature.  The state machine around that primitive is NutFC-specific.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from threading import RLock

from cashu.core.crypto.b_dhke import (
    carol_verify_dleq,
    step1_alice,
    step2_bob,
    step3_alice,
)
from cashu.core.crypto.keys import PrivateKey
from cashu.core.crypto.secp import PublicKey


class NutFCError(Exception):
    """Base class for expected protocol failures."""


class UnknownAssetError(NutFCError):
    """The catalog does not contain the requested asset."""


class InvalidCredentialError(NutFCError):
    """A credential signature or opening is invalid."""


class DoubleSpendError(NutFCError):
    """A credential's nullifier has already been consumed."""


@dataclass(frozen=True, slots=True)
class Asset:
    collection_id: str
    asset_id: str
    name: str
    rarity: str


class AssetCatalog:
    """A small public catalog used to validate collectible identities."""

    def __init__(self, assets: list[Asset] | tuple[Asset, ...]) -> None:
        self._assets = {asset.asset_id: asset for asset in assets}
        if len(self._assets) != len(assets):
            raise ValueError("asset IDs must be unique")

    def get(self, asset_id: str) -> Asset:
        try:
            return self._assets[asset_id]
        except KeyError as error:
            raise UnknownAssetError(f"unknown asset: {asset_id}") from error

    def __contains__(self, asset_id: object) -> bool:
        return asset_id in self._assets


@dataclass(slots=True)
class BlindSignature:
    """The mint response before the wallet removes its blinding factor."""

    C_: str
    e: str
    s: str


@dataclass(slots=True)
class Signature:
    """An unblinded Cashu signature plus the local data needed to verify it."""

    C: str
    e: str
    s: str
    r: str


@dataclass(slots=True)
class PendingCredential:
    asset: Asset
    owner_secret: str
    salt: str
    secret: str
    blinded_message: PublicKey
    blinding_factor: PrivateKey

    def finalize(self, response: BlindSignature, issuer_public_key: PublicKey) -> Credential:
        signed_blinded_message = PublicKey(bytes.fromhex(response.C_))
        signature = step3_alice(
            signed_blinded_message,
            self.blinding_factor,
            issuer_public_key,
        )
        return Credential(
            asset=self.asset,
            owner_secret=self.owner_secret,
            salt=self.salt,
            signature=Signature(
                C=signature.format().hex(),
                e=response.e,
                s=response.s,
                r=self.blinding_factor.to_hex(),
            ),
        )


@dataclass(slots=True)
class Credential:
    """A wallet-held collectible credential.

    The opening is kept by the wallet.  Only its commitment and nullifier are
    intended for public/state tracking; the current prototype still presents
    the opening to the local mint during transfer validation.
    """

    asset: Asset
    owner_secret: str
    salt: str
    signature: Signature

    @property
    def collection_id(self) -> str:
        return self.asset.collection_id

    @property
    def asset_id(self) -> str:
        return self.asset.asset_id

    @property
    def secret(self) -> str:
        opening = {
            "asset_id": self.asset.asset_id,
            "collection_id": self.asset.collection_id,
            "owner_secret": self.owner_secret,
            "rarity": self.asset.rarity,
            "salt": self.salt,
        }
        return json.dumps(opening, sort_keys=True, separators=(",", ":"))

    @property
    def commitment(self) -> str:
        return hashlib.sha256(self.secret.encode()).hexdigest()

    @property
    def nullifier(self) -> str:
        material = f"nutfc:nullifier:{self.collection_id}:{self.asset_id}:{self.owner_secret}"
        return hashlib.sha256(material.encode()).hexdigest()

    def verify(self, issuer_public_key: PublicKey) -> bool:
        try:
            return carol_verify_dleq(
                self.secret,
                PrivateKey(bytes.fromhex(self.signature.r)),
                PublicKey(bytes.fromhex(self.signature.C)),
                PrivateKey(bytes.fromhex(self.signature.e)),
                PrivateKey(bytes.fromhex(self.signature.s)),
                issuer_public_key,
            )
        except (TypeError, ValueError):
            return False


class LocalMint:
    """An in-memory Nutshell-backed issuer and spent-state authority."""

    def __init__(self, catalog: AssetCatalog) -> None:
        self.catalog = catalog
        self._private_key = PrivateKey()
        self.public_key = self._private_key.public_key
        assert self.public_key is not None
        self._spent: set[str] = set()
        self._lock = RLock()
        self.issued_blinded_count = 0

    def issue_blinded(self, blinded_message: PublicKey) -> BlindSignature:
        """Sign a wallet-created blinded message using Cashu's blind DHKE."""
        signed, challenge, response = step2_bob(blinded_message, self._private_key)
        self.issued_blinded_count += 1
        return BlindSignature(
            C_=signed.format().hex(),
            e=challenge.to_hex(),
            s=response.to_hex(),
        )

    def is_spent(self, nullifier: str) -> bool:
        return nullifier in self._spent

    def consume_and_issue(
        self, credential: Credential, destination: PendingCredential
    ) -> Credential:
        """Atomically consume ``credential`` and issue its replacement."""
        with self._lock:
            if self.is_spent(credential.nullifier):
                raise DoubleSpendError("credential has already been spent")
            if credential.asset_id != destination.asset.asset_id:
                raise InvalidCredentialError("destination asset does not match")
            if credential.asset_id not in self.catalog:
                raise UnknownAssetError(f"unknown asset: {credential.asset_id}")
            if not credential.verify(self.public_key):
                raise InvalidCredentialError("credential signature is invalid")

            # Build the replacement completely before changing spent state. If
            # any of these operations raises, the old credential remains valid.
            response = self.issue_blinded(destination.blinded_message)
            replacement = destination.finalize(response, self.public_key)
            self._spent.add(credential.nullifier)
            return replacement


class Wallet:
    """A minimal local wallet that owns openings and talks to one mint."""

    def __init__(self, mint: LocalMint, catalog: AssetCatalog) -> None:
        self.issuer = mint
        self.catalog = catalog

    def prepare_destination(self, asset_id: str) -> PendingCredential:
        asset = self.catalog.get(asset_id)
        owner_secret = secrets.token_hex(32)
        salt = secrets.token_hex(16)
        opening = {
            "asset_id": asset.asset_id,
            "collection_id": asset.collection_id,
            "owner_secret": owner_secret,
            "rarity": asset.rarity,
            "salt": salt,
        }
        secret = json.dumps(opening, sort_keys=True, separators=(",", ":"))
        blinded_message, blinding_factor = step1_alice(secret)
        return PendingCredential(
            asset=asset,
            owner_secret=owner_secret,
            salt=salt,
            secret=secret,
            blinded_message=blinded_message,
            blinding_factor=blinding_factor,
        )

    def mint(self, asset_id: str) -> Credential:
        pending = self.prepare_destination(asset_id)
        response = self.issuer.issue_blinded(pending.blinded_message)
        return pending.finalize(response, self.issuer.public_key)

    def transfer(self, credential: Credential, recipient: Wallet) -> Credential:
        destination = recipient.prepare_destination(credential.asset_id)
        return self.issuer.consume_and_issue(credential, destination)
