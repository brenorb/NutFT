from __future__ import annotations

import json
from collections import Counter
from dataclasses import replace

import pytest

from nutfc.core import (
    Asset,
    AssetCatalog,
    BoosterPolicy,
    BoosterSlot,
    DoubleSpendError,
    LocalMint,
    PossessionError,
    Wallet,
)
from nutfc.token import NutFCToken


@pytest.fixture
def catalog() -> AssetCatalog:
    return AssetCatalog(
        [
            Asset("demo-cards", "mythic-1", "Mythic One", "mythic"),
            Asset("demo-cards", "rare-1", "Rare One", "rare"),
            Asset("demo-cards", "rare-2", "Rare Two", "rare"),
            Asset("demo-cards", "uncommon-1", "Uncommon One", "uncommon"),
            Asset("demo-cards", "uncommon-2", "Uncommon Two", "uncommon"),
            Asset("demo-cards", "common-1", "Common One", "common"),
            Asset("demo-cards", "common-2", "Common Two", "common"),
        ]
    )


@pytest.fixture
def mint(catalog: AssetCatalog) -> LocalMint:
    return LocalMint(catalog, mint_url="https://mint.example")


def test_mint_signs_public_card_definition(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    definition = mint.signed_asset("rare-1")

    assert definition.definition_hash
    assert definition.issuer_signature
    assert definition.verify_issuer_signature(mint.public_key)
    assert definition.properties == {}
    assert catalog.get("rare-1").definition_hash == definition.definition_hash


def test_owner_bound_challenge_response_proves_current_possession(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    credential = alice.mint("rare-1")
    challenge = b"game-session:1234"

    proof = alice.prove_possession(credential, challenge)

    assert mint.verify_possession(credential, proof, challenge)
    assert not mint.verify_possession(credential, proof, b"game-session:other")


def test_spent_credential_cannot_pass_current_possession_check(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    bob = Wallet(mint, catalog)
    credential = alice.mint("rare-1")
    challenge = b"trade-session:1234"
    proof = alice.prove_possession(credential, challenge)

    alice.transfer(credential, bob)

    assert not mint.verify_possession(credential, proof, challenge)


def test_nullifier_binds_the_full_card_commitment(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    credential = alice.mint("rare-1")
    changed_opening = replace(credential, salt="different-salt")

    assert changed_opening.commitment != credential.commitment
    assert changed_opening.nullifier != credential.nullifier


def test_transfer_requires_the_current_owner_key(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    bob = Wallet(mint, catalog)
    carol = Wallet(mint, catalog)
    credential = alice.mint("rare-1")

    with pytest.raises(PossessionError):
        bob.transfer(credential, carol)


def test_booster_opening_emits_one_card_per_configured_slot(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    policy = BoosterPolicy(
        policy_id="demo-v1",
        collection_id="demo-cards",
        slots=(
            BoosterSlot("rare", "rare", count=1),
            BoosterSlot("uncommon", "uncommon", count=3),
            BoosterSlot("common", "common", count=8),
        ),
    )

    booster = alice.buy_booster(policy)
    cards = alice.open_booster(booster)

    assert len(cards) == 12
    assert Counter(card.asset.rarity for card in cards) == {
        "rare": 1,
        "uncommon": 3,
        "common": 8,
    }
    assert all(card.asset.issuer_signature for card in cards)
    assert mint.is_booster_spent(booster.booster_id)

    with pytest.raises(DoubleSpendError):
        alice.open_booster(booster)


def test_cashu_extended_token_round_trips_without_private_opening(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    credential = alice.mint("rare-1")
    token = NutFCToken.from_credential(credential, mint_url=mint.mint_url)

    serialized = token.serialize()
    parsed = NutFCToken.deserialize(serialized)
    public = json.loads(serialized)

    assert parsed == token
    assert public["protocol"] == "nutfc"
    assert public["cashu"]["unit"] == "card"
    assert public["cashu"]["proofs"][0]["amount"] == 1
    assert public["nutfc"]["card_commitment"] == credential.commitment
    assert "owner_secret" not in serialized
    assert "salt" not in serialized
