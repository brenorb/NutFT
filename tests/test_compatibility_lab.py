from __future__ import annotations

import hashlib
import json
from dataclasses import replace

from nutft.core import Asset, AssetCatalog, LocalMint, Wallet


def test_compatibility_lab_card_authenticity_state_and_transfer() -> None:
    blob = b"card-art-v1"
    blob_hash = hashlib.sha256(blob).hexdigest()
    card = Asset(
        "compat-cards",
        "card-001",
        "Compatibility Card",
        "rare",
        "blossom://card-001",
        {"power": 1, "types": ["artifact"]},
        blob_hash=blob_hash,
    )
    reordered = replace(
        card, properties={"types": ["artifact"], "power": 1}
    )
    canonical = json.dumps(
        {
            "asset_id": card.asset_id,
            "blob_hash": blob_hash,
            "collection_id": card.collection_id,
            "image_url": card.image_url,
            "name": card.name,
            "properties": card.properties,
            "rarity": card.rarity,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    assert hashlib.sha256(blob).hexdigest() == card.blob_hash
    assert card.definition_hash == reordered.definition_hash
    assert card.definition_hash == hashlib.sha256(canonical).hexdigest()

    mint = LocalMint(AssetCatalog([card]))
    alice = Wallet(mint, mint.catalog)
    bob = Wallet(mint, mint.catalog)
    credential = alice.mint(card.asset_id)
    assert credential.verify(mint.public_key)
    assert not replace(
        credential,
        signature=replace(credential.signature, C="00" * 33),
    ).verify(mint.public_key)

    proof = alice.prove_possession(credential, b"compatibility-lab")
    assert mint.check_state([credential.nullifier]) == ["UNSPENT"]
    alice.transfer(credential, bob)
    assert mint.check_state([credential.nullifier]) == ["SPENT"]
    assert not mint.verify_possession(credential, proof, b"compatibility-lab")
