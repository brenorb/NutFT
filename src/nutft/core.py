"""Minimal NutFT protocol primitives built on Cashu/Nutshell crypto."""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field, replace
from threading import RLock

from cashu.core.crypto.b_dhke import (
    alice_verify_dleq,
    hash_to_curve,
    step1_alice,
    step2_bob,
    step3_alice,
)
from cashu.core.crypto.keys import PrivateKey
from cashu.core.crypto.secp import PublicKey


class NutFTError(Exception):
    """Base class for expected protocol failures."""


class UnknownAssetError(NutFTError):
    """The catalog does not contain the requested asset."""


class InvalidCredentialError(NutFTError):
    """A credential signature, opening, or definition is invalid."""


class DoubleSpendError(NutFTError):
    """A credential or booster has already been consumed."""


class PossessionError(NutFTError):
    """The caller cannot prove control of the current owner key."""


class InvalidPolicyError(NutFTError):
    """A booster policy is malformed or not issued by this mint."""


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _message(domain: str, value: object) -> bytes:
    return f"nutft:{domain}:".encode() + _canonical(value).encode()


def _sign(key: PrivateKey, domain: str, value: object) -> str:
    return key.sign(_message(domain, value)).hex()


def _verify_signature(
    key: PublicKey, signature: str, domain: str, value: object
) -> bool:
    try:
        return key.verify(bytes.fromhex(signature), _message(domain, value))
    except (TypeError, ValueError):
        return False


def _verify_cashu_signature(
    secret: str, signature: Signature, issuer_public_key: PublicKey
) -> bool:
    """Verify a current Cashu DLEQ proof without legacy compatibility fallbacks."""
    try:
        r = PrivateKey(bytes.fromhex(signature.r))
        c = PublicKey(bytes.fromhex(signature.C))
        e = PrivateKey(bytes.fromhex(signature.e))
        s = PrivateKey(bytes.fromhex(signature.s))
        blinded_message = hash_to_curve(secret.encode()) + r.public_key
        blinded_signature = c + issuer_public_key * r
        return alice_verify_dleq(
            blinded_message, blinded_signature, e, s, issuer_public_key
        )
    except (TypeError, ValueError):
        return False


@dataclass(frozen=True, slots=True)
class CardDefinition:
    """Public, signed metadata for a collectible card."""

    collection_id: str
    asset_id: str
    name: str
    rarity: str
    image_url: str = ""
    properties: Mapping[str, object] = field(default_factory=dict)
    issuer_signature: str = ""
    blob_hash: str = ""

    @property
    def card_id(self) -> str:
        return self.asset_id

    @property
    def definition_hash(self) -> str:
        payload = {
            "collection_id": self.collection_id,
            "asset_id": self.asset_id,
            "name": self.name,
            "rarity": self.rarity,
            "image_url": self.image_url,
            "properties": self.properties,
            "blob_hash": self.blob_hash,
        }
        return hashlib.sha256(_canonical(payload).encode()).hexdigest()

    def with_issuer_signature(self, signature: str) -> CardDefinition:
        return replace(self, issuer_signature=signature)

    def verify_issuer_signature(self, issuer_public_key: PublicKey) -> bool:
        return bool(self.issuer_signature) and _verify_signature(
            issuer_public_key,
            self.issuer_signature,
            "card-definition",
            {"definition_hash": self.definition_hash},
        )


# Keep the original prototype name as a small compatibility alias.
Asset = CardDefinition


class AssetCatalog:
    """A public catalog keyed by collection and card identifier."""

    def __init__(
        self, assets: list[CardDefinition] | tuple[CardDefinition, ...]
    ) -> None:
        self._assets = {
            (asset.collection_id, asset.asset_id): asset for asset in assets
        }
        if len(self._assets) != len(assets):
            raise ValueError("card IDs must be unique within a collection")

    @property
    def assets(self) -> tuple[CardDefinition, ...]:
        return tuple(self._assets.values())

    def get(self, asset_id: str, collection_id: str | None = None) -> CardDefinition:
        matches = [
            asset
            for (collection, card_id), asset in self._assets.items()
            if card_id == asset_id
            and (collection_id is None or collection == collection_id)
        ]
        if len(matches) != 1:
            raise UnknownAssetError(f"unknown or ambiguous asset: {asset_id}")
        return matches[0]

    def for_rarity(self, collection_id: str, rarity: str) -> tuple[CardDefinition, ...]:
        return tuple(
            asset
            for asset in self._assets.values()
            if asset.collection_id == collection_id and asset.rarity == rarity
        )

    def __contains__(self, asset_id: object) -> bool:
        return any(card_id == asset_id for _, card_id in self._assets)


@dataclass(frozen=True, slots=True)
class BoosterSlot:
    slot_id: str
    rarity: str
    count: int = 1

    def __post_init__(self) -> None:
        if (
            not self.slot_id
            or not self.rarity
            or type(self.count) is not int
            or self.count <= 0
        ):
            raise InvalidPolicyError(
                "booster slots need a name, rarity, and positive count"
            )


@dataclass(frozen=True, slots=True)
class BoosterPolicy:
    """Signed application policy; fairness proofs are an optional extension."""

    policy_id: str
    collection_id: str
    slots: tuple[BoosterSlot, ...]
    algorithm: str = "nutft-draw-v1"
    issuer_signature: str = ""

    def __post_init__(self) -> None:
        if not self.policy_id or not self.collection_id or not self.slots:
            raise InvalidPolicyError(
                "booster policy requires an ID, collection, and slots"
            )
        if len({slot.slot_id for slot in self.slots}) != len(self.slots):
            raise InvalidPolicyError("booster slot IDs must be unique")

    @property
    def total_cards(self) -> int:
        return sum(slot.count for slot in self.slots)

    @property
    def policy_hash(self) -> str:
        payload = {
            "policy_id": self.policy_id,
            "collection_id": self.collection_id,
            "slots": [
                {"slot_id": slot.slot_id, "rarity": slot.rarity, "count": slot.count}
                for slot in self.slots
            ],
            "algorithm": self.algorithm,
        }
        return hashlib.sha256(_canonical(payload).encode()).hexdigest()

    def with_issuer_signature(self, signature: str) -> BoosterPolicy:
        return replace(self, issuer_signature=signature)

    def verify_issuer_signature(self, issuer_public_key: PublicKey) -> bool:
        return bool(self.issuer_signature) and _verify_signature(
            issuer_public_key,
            self.issuer_signature,
            "booster-policy",
            {"policy_hash": self.policy_hash},
        )


@dataclass(slots=True)
class BlindSignature:
    C_: str
    e: str
    s: str


@dataclass(slots=True)
class Signature:
    C: str
    e: str
    s: str
    r: str


@dataclass(slots=True)
class PossessionProof:
    challenge: bytes
    card_commitment: str
    card_id: str
    definition_hash: str
    owner_public_key: str
    signature: str


@dataclass(frozen=True, slots=True)
class BlindedDestination:
    """Only the public destination data sent to the mint for a transfer."""

    asset: CardDefinition
    owner_public_key: str
    blinded_message: PublicKey
    slot_id: str | None = None
    booster_id: str | None = None
    policy_id: str | None = None


def _opening(
    asset: CardDefinition, owner_secret: str, salt: str, owner_public_key: str
) -> dict[str, str]:
    return {
        "asset_id": asset.asset_id,
        "collection_id": asset.collection_id,
        "definition_hash": asset.definition_hash,
        "rarity": asset.rarity,
        "owner_secret": owner_secret,
        "owner_public_key": owner_public_key,
        "salt": salt,
    }


def _commitment(
    asset: CardDefinition, owner_secret: str, salt: str, owner_public_key: str
) -> str:
    return hashlib.sha256(
        _canonical(_opening(asset, owner_secret, salt, owner_public_key)).encode()
    ).hexdigest()


@dataclass(slots=True)
class PendingCredential:
    asset: CardDefinition
    owner_secret: str
    salt: str
    blinded_message: PublicKey
    blinding_factor: PrivateKey
    owner_public_key: str
    slot_id: str | None = None
    booster_id: str | None = None
    policy_id: str | None = None

    @property
    def commitment(self) -> str:
        return _commitment(
            self.asset,
            self.owner_secret,
            self.salt,
            self.owner_public_key,
        )

    def finalize(
        self, response: BlindSignature, issuer_public_key: PublicKey
    ) -> Credential:
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
            owner_public_key=self.owner_public_key,
            signature=Signature(
                C=signature.format().hex(),
                e=response.e,
                s=response.s,
                r=self.blinding_factor.to_hex(),
            ),
            slot_id=self.slot_id,
            booster_id=self.booster_id,
            policy_id=self.policy_id,
        )

    @property
    def destination(self) -> BlindedDestination:
        return BlindedDestination(
            asset=self.asset,
            owner_public_key=self.owner_public_key,
            blinded_message=self.blinded_message,
            slot_id=self.slot_id,
            booster_id=self.booster_id,
            policy_id=self.policy_id,
        )


@dataclass(slots=True)
class Credential:
    """Wallet-held card credential; the opening stays local to the wallet."""

    asset: CardDefinition
    owner_secret: str
    salt: str
    owner_public_key: str
    signature: Signature
    slot_id: str | None = None
    booster_id: str | None = None
    policy_id: str | None = None

    @property
    def collection_id(self) -> str:
        return self.asset.collection_id

    @property
    def asset_id(self) -> str:
        return self.asset.asset_id

    @property
    def secret(self) -> str:
        """Return the private opening for compatibility with the first prototype."""
        return _canonical(
            _opening(
                self.asset,
                self.owner_secret,
                self.salt,
                self.owner_public_key,
            )
        )

    @property
    def commitment(self) -> str:
        return _commitment(
            self.asset,
            self.owner_secret,
            self.salt,
            self.owner_public_key,
        )

    @property
    def cashu_secret(self) -> str:
        """The opaque Cashu secret signed by the mint."""
        return self.commitment

    @property
    def nullifier(self) -> str:
        material = f"nutft:nullifier:{self.collection_id}:{self.commitment}:{self.owner_secret}"
        return hashlib.sha256(material.encode()).hexdigest()

    def verify(self, issuer_public_key: PublicKey) -> bool:
        return self.asset.verify_issuer_signature(
            issuer_public_key
        ) and _verify_cashu_signature(
            self.cashu_secret, self.signature, issuer_public_key
        )


@dataclass(slots=True)
class BoosterCredential:
    booster_id: str
    policy_id: str
    collection_id: str
    policy_hash: str
    owner_public_key: str
    secret: str
    signature: Signature

    def verify(self, issuer_public_key: PublicKey) -> bool:
        try:
            fields = json.loads(self.secret)
            if not isinstance(fields, dict) or any(
                fields.get(key) != value
                for key, value in (
                    ("booster_id", self.booster_id),
                    ("policy_hash", self.policy_hash),
                    ("owner_public_key", self.owner_public_key),
                )
            ):
                return False
            return _verify_cashu_signature(
                self.secret, self.signature, issuer_public_key
            )
        except (TypeError, ValueError):
            return False


class LocalMint:
    """An in-memory mint and spent-state authority for the first prototype."""

    keyset_id = "nutft-card-v1"

    def __init__(
        self, catalog: AssetCatalog, mint_url: str = "https://mint.local"
    ) -> None:
        self.catalog = catalog
        self.mint_url = mint_url.rstrip("/")
        self._private_key = PrivateKey()
        self.public_key = self._private_key.public_key
        self._spent: set[str] = set()
        self._spent_boosters: set[str] = set()
        self._lock = RLock()
        self.issued_blinded_count = 0

    def signed_asset(self, asset_id: str) -> CardDefinition:
        asset = self.catalog.get(asset_id)
        return asset.with_issuer_signature(
            _sign(
                self._private_key,
                "card-definition",
                {"definition_hash": asset.definition_hash},
            )
        )

    def signed_policy(self, policy: BoosterPolicy) -> BoosterPolicy:
        if policy.collection_id not in {
            asset.collection_id for asset in self.catalog.assets
        }:
            raise InvalidPolicyError("policy collection is not in this mint's catalog")
        return policy.with_issuer_signature(
            _sign(
                self._private_key, "booster-policy", {"policy_hash": policy.policy_hash}
            )
        )

    def _issue_blinded(self, blinded_message: PublicKey) -> BlindSignature:
        signed, challenge, response = step2_bob(blinded_message, self._private_key)
        self.issued_blinded_count += 1
        return BlindSignature(
            C_=signed.format().hex(),
            e=challenge.to_hex(),
            s=response.to_hex(),
        )

    def is_spent(self, nullifier: str) -> bool:
        return nullifier in self._spent

    def check_state(self, nullifiers: Iterable[str]) -> list[str]:
        """Return NUT-07-style state labels for the supplied nullifiers."""
        return [
            "SPENT" if self.is_spent(nullifier) else "UNSPENT"
            for nullifier in nullifiers
        ]

    def is_booster_spent(self, booster_id: str) -> bool:
        return booster_id in self._spent_boosters

    def verify_possession(
        self,
        credential: Credential,
        proof: PossessionProof,
        challenge: bytes | None = None,
    ) -> bool:
        if challenge is not None and proof.challenge != challenge:
            return False
        if self.is_spent(credential.nullifier):
            return False
        if (
            proof.card_commitment != credential.commitment
            or proof.card_id != credential.asset_id
            or proof.definition_hash != credential.asset.definition_hash
            or proof.owner_public_key != credential.owner_public_key
            or not credential.verify(self.public_key)
        ):
            return False
        try:
            owner_public_key = PublicKey(bytes.fromhex(proof.owner_public_key))
            payload = _message(
                "possession",
                {
                    "challenge": proof.challenge.hex(),
                    "card_commitment": proof.card_commitment,
                    "card_id": proof.card_id,
                    "definition_hash": proof.definition_hash,
                },
            )
            return owner_public_key.verify(bytes.fromhex(proof.signature), payload)
        except (TypeError, ValueError):
            return False

    def consume_and_issue(
        self,
        credential: Credential,
        destination: BlindedDestination,
        possession: PossessionProof,
    ) -> BlindSignature:
        """Consume a card and issue its replacement as one in-memory operation."""
        with self._lock:
            if self.is_spent(credential.nullifier):
                raise DoubleSpendError("credential has already been spent")
            if not credential.verify(self.public_key):
                raise InvalidCredentialError("credential signature is invalid")
            if not self.verify_possession(credential, possession):
                raise PossessionError("current owner proof is invalid")
            if credential.asset.definition_hash != destination.asset.definition_hash:
                raise InvalidCredentialError(
                    "destination card definition does not match"
                )
            if credential.collection_id != destination.asset.collection_id:
                raise InvalidCredentialError("destination collection does not match")

            response = self._issue_blinded(destination.blinded_message)
            self._spent.add(credential.nullifier)
            return response

    def open_booster(
        self,
        booster: BoosterCredential,
        policy: BoosterPolicy,
        prepare_destination: Callable[
            [CardDefinition, str, str, str], PendingCredential
        ],
    ) -> list[Credential]:
        """Open a booster using the mint-trusted policy and random draw."""
        with self._lock:
            if self.is_booster_spent(booster.booster_id):
                raise DoubleSpendError("booster has already been opened")
            if (
                booster.policy_id != policy.policy_id
                or booster.policy_hash != policy.policy_hash
                or not policy.verify_issuer_signature(self.public_key)
                or not booster.verify(self.public_key)
            ):
                raise InvalidPolicyError("booster or policy is not valid for this mint")

            pending: list[PendingCredential] = []
            for slot in policy.slots:
                candidates = self.catalog.for_rarity(policy.collection_id, slot.rarity)
                if not candidates:
                    raise InvalidPolicyError(f"no cards for rarity {slot.rarity}")
                for _ in range(slot.count):
                    asset = self.signed_asset(secrets.choice(candidates).asset_id)
                    pending.append(
                        prepare_destination(
                            asset, slot.slot_id, booster.booster_id, policy.policy_id
                        )
                    )

            responses = [self._issue_blinded(item.blinded_message) for item in pending]
            cards = [
                item.finalize(response, self.public_key)
                for item, response in zip(pending, responses, strict=True)
            ]
            self._spent_boosters.add(booster.booster_id)
            return cards


class Wallet:
    """A minimal wallet that stores openings and an owner key locally."""

    def __init__(self, mint: LocalMint, catalog: AssetCatalog) -> None:
        self.issuer = mint
        self.catalog = catalog
        self._owner_key = PrivateKey()

    @property
    def owner_public_key(self) -> str:
        return self._owner_key.public_key.format().hex()

    def prepare_destination(
        self,
        asset_id: str | CardDefinition,
        slot_id: str | None = None,
        booster_id: str | None = None,
        policy_id: str | None = None,
    ) -> PendingCredential:
        asset = (
            asset_id
            if isinstance(asset_id, CardDefinition)
            else self.issuer.signed_asset(asset_id)
        )
        owner_secret = secrets.token_hex(32)
        salt = secrets.token_hex(16)
        blinded_message, blinding_factor = step1_alice(
            _commitment(asset, owner_secret, salt, self.owner_public_key)
        )
        return PendingCredential(
            asset=asset,
            owner_secret=owner_secret,
            salt=salt,
            blinded_message=blinded_message,
            blinding_factor=blinding_factor,
            owner_public_key=self.owner_public_key,
            slot_id=slot_id,
            booster_id=booster_id,
            policy_id=policy_id,
        )

    def mint(self, asset_id: str) -> Credential:
        pending = self.prepare_destination(asset_id)
        response = self.issuer._issue_blinded(pending.blinded_message)
        return pending.finalize(response, self.issuer.public_key)

    def prove_possession(
        self, credential: Credential, challenge: bytes
    ) -> PossessionProof:
        if not challenge:
            raise PossessionError("challenge must not be empty")
        if credential.owner_public_key != self.owner_public_key:
            raise PossessionError("wallet does not own this credential")
        payload = _message(
            "possession",
            {
                "challenge": challenge.hex(),
                "card_commitment": credential.commitment,
                "card_id": credential.asset_id,
                "definition_hash": credential.asset.definition_hash,
            },
        )
        return PossessionProof(
            challenge=challenge,
            card_commitment=credential.commitment,
            card_id=credential.asset_id,
            definition_hash=credential.asset.definition_hash,
            owner_public_key=self.owner_public_key,
            signature=self._owner_key.sign(payload).hex(),
        )

    def transfer(self, credential: Credential, recipient: Wallet) -> Credential:
        challenge = secrets.token_bytes(32)
        possession = self.prove_possession(credential, challenge)
        destination = recipient.prepare_destination(credential.asset_id)
        response = self.issuer.consume_and_issue(
            credential, destination.destination, possession
        )
        return destination.finalize(response, self.issuer.public_key)

    def buy_booster(self, policy: BoosterPolicy) -> BoosterCredential:
        signed_policy = self.issuer.signed_policy(policy)
        booster_id = secrets.token_hex(16)
        secret = _canonical(
            {
                "booster_id": booster_id,
                "policy_hash": signed_policy.policy_hash,
                "owner_public_key": self.owner_public_key,
                "salt": secrets.token_hex(16),
            }
        )
        blinded_message, blinding_factor = step1_alice(secret)
        response = self.issuer._issue_blinded(blinded_message)
        signed_blinded_message = PublicKey(bytes.fromhex(response.C_))
        signature = step3_alice(
            signed_blinded_message, blinding_factor, self.issuer.public_key
        )
        return BoosterCredential(
            booster_id=booster_id,
            policy_id=signed_policy.policy_id,
            collection_id=signed_policy.collection_id,
            policy_hash=signed_policy.policy_hash,
            owner_public_key=self.owner_public_key,
            secret=secret,
            signature=Signature(
                C=signature.format().hex(),
                e=response.e,
                s=response.s,
                r=blinding_factor.to_hex(),
            ),
        )

    def open_booster(
        self, booster: BoosterCredential, policy: BoosterPolicy
    ) -> list[Credential]:
        policy = self.issuer.signed_policy(policy)
        if policy.policy_hash != booster.policy_hash:
            raise InvalidPolicyError("wallet needs the exact booster policy to open")
        return self.issuer.open_booster(
            booster,
            policy,
            lambda asset, slot_id, booster_id, policy_id: self.prepare_destination(
                asset, slot_id, booster_id, policy_id
            ),
        )
