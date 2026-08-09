from __future__ import annotations

import pytest

from nutfc.core import (
    Asset,
    AssetCatalog,
    DoubleSpendError,
    InvalidCredentialError,
    LocalMint,
    UnknownAssetError,
    Wallet,
)


@pytest.fixture
def catalog() -> AssetCatalog:
    return AssetCatalog(
        [
            Asset(
                collection_id="demo-cards",
                asset_id="black-lotus",
                name="Black Lotus",
                rarity="mythic",
            ),
            Asset(
                collection_id="demo-cards",
                asset_id="forest",
                name="Forest",
                rarity="common",
            ),
        ]
    )


@pytest.fixture
def mint(catalog: AssetCatalog) -> LocalMint:
    return LocalMint(catalog)


def test_wallet_receives_a_nutshell_signed_collectible(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)

    credential = alice.mint("black-lotus")

    assert credential.asset_id == "black-lotus"
    assert credential.collection_id == "demo-cards"
    assert credential.commitment
    assert "black-lotus" not in credential.commitment
    assert credential.verify(mint.public_key)
    assert mint.issued_blinded_count == 1


def test_wallet_rejects_assets_outside_the_catalog(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)

    with pytest.raises(UnknownAssetError):
        alice.mint("not-a-card")


def test_transfer_is_atomic_and_rejects_a_second_spend(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    bob = Wallet(mint, catalog)
    original = alice.mint("black-lotus")

    received = alice.transfer(original, bob)

    assert received.asset_id == original.asset_id
    assert received.commitment != original.commitment
    assert received.owner_secret != original.owner_secret
    assert mint.is_spent(original.nullifier)

    with pytest.raises(DoubleSpendError):
        alice.transfer(original, bob)


def test_invalid_credential_does_not_consume_the_original(
    mint: LocalMint, catalog: AssetCatalog
) -> None:
    alice = Wallet(mint, catalog)
    bob = Wallet(mint, catalog)
    credential = alice.mint("black-lotus")
    credential.signature.C = "00" * 33

    with pytest.raises(InvalidCredentialError):
        alice.transfer(credential, bob)

    assert not mint.is_spent(credential.nullifier)
