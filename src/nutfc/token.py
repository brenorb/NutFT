"""Cashu-extended NutFC card token envelope.

The envelope keeps the Cashu proof material and NutFC references together, but
does not serialize the wallet's card opening or owner secret.
"""

from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from cashu.core.base import Proof

from .core import Credential


@dataclass(frozen=True, slots=True)
class NutFCToken:
    mint_url: str
    cashu: dict[str, Any]
    nutfc: dict[str, Any]

    @classmethod
    def from_credential(cls, credential: Credential, *, mint_url: str) -> NutFCToken:
        proof = Proof(
            id="nutfc-card-v1",
            amount=1,
            secret=credential.cashu_secret,
            C=credential.signature.C,
            dleq={
                "e": credential.signature.e,
                "s": credential.signature.s,
                "r": credential.signature.r,
            },
        ).to_dict(include_dleq=True)
        if hasattr(proof.get("dleq"), "model_dump"):
            proof["dleq"] = proof["dleq"].model_dump()
        return cls(
            mint_url=mint_url.rstrip("/"),
            cashu={
                "mint": mint_url.rstrip("/"),
                "unit": "card",
                "proofs": [proof],
            },
            nutfc={
                "version": 1,
                "collection_id": credential.collection_id,
                "card_commitment": credential.commitment,
                "definition_hash": credential.asset.definition_hash,
                "rarity": credential.asset.rarity,
                "owner_public_key": credential.owner_public_key,
                "slot_id": credential.slot_id,
                "booster_id": credential.booster_id,
                "policy_id": credential.policy_id,
            },
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocol": "nutfc",
            "version": 1,
            "mint": self.mint_url,
            "cashu": self.cashu,
            "nutfc": self.nutfc,
        }

    def serialize(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))

    @classmethod
    def deserialize(cls, serialized: str) -> NutFCToken:
        try:
            payload = json.loads(serialized)
        except json.JSONDecodeError as error:
            raise ValueError("invalid NutFC token JSON") from error
        if (
            not isinstance(payload, dict)
            or payload.get("protocol") != "nutfc"
            or payload.get("version") != 1
            or not isinstance(payload.get("mint"), str)
            or not isinstance(payload.get("cashu"), dict)
            or not isinstance(payload.get("nutfc"), dict)
        ):
            raise ValueError("invalid NutFC token envelope")
        nutfc = payload["nutfc"]
        if "opening" in payload or any(
            key in nutfc for key in ("opening", "owner_secret", "salt")
        ):
            raise ValueError("private card opening must not be in a public token")
        cashu = payload["cashu"]
        if (
            cashu.get("mint", "").rstrip("/") != payload["mint"].rstrip("/")
            or cashu.get("unit") != "card"
            or not isinstance(cashu.get("proofs"), list)
            or len(cashu["proofs"]) != 1
        ):
            raise ValueError("invalid Cashu proof section")
        try:
            Proof.from_dict(deepcopy(cashu["proofs"][0]))
        except (TypeError, ValueError, KeyError) as error:
            raise ValueError("invalid Cashu proof") from error
        return cls(
            mint_url=payload["mint"].rstrip("/"),
            cashu=payload["cashu"],
            nutfc=payload["nutfc"],
        )
