"""Flat demo premium: charged before a policy exists, recorded on it, and never reusable."""

import pytest
from fastapi.testclient import TestClient

import app.escrow as escrow_mod
import app.main as main
import app.policy_store as store
from app.payment import PremiumError

PAYEE = "GYwymMhybDFa5iJeAPxZGGdNG1EfPNhTZQa9u2dXbuTo"
PAYER = "CzLAGgxrqNhjAhh4Yg6CN1bAvBTtFi9VUhTPi1o1sVSt"
BODY = {"region": "Warsaw", "lat": 52.23, "lon": 21.01, "sum_insured_sol": 1.0, "product_type": "crop_drought", "payee_pubkey": PAYEE}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "STORE_PATH", tmp_path / "policies.json")
    monkeypatch.setattr(escrow_mod, "LEDGER_PATH", tmp_path / "escrow_ledger.json")
    return TestClient(main.app)


def test_demo_wallet_premium_is_charged_and_recorded(client, monkeypatch):
    charged = []
    async def fake_collect(amount_sol):
        charged.append(amount_sol)
        return "demo-premium-sig"
    monkeypatch.setattr(main, "collect_demo_premium", fake_collect)
    r = client.post("/policy", json=BODY)
    assert r.status_code == 201, r.text
    assert charged == [pytest.approx(1.0 * main.PREMIUM_RATE)]
    p = r.json()
    assert p["premium_sol"] == pytest.approx(0.03) and p["premium_tx_signature"] == "demo-premium-sig"


def test_no_policy_when_the_premium_cannot_be_paid(client, monkeypatch):
    async def broke(amount_sol): raise PremiumError("The demo wallet has 0.0000 SOL, not enough for the premium.")
    monkeypatch.setattr(main, "collect_demo_premium", broke)
    r = client.post("/policy", json=BODY)
    assert r.status_code == 402 and "not enough" in r.json()["detail"]
    assert client.get("/policy").json()["policies"] == []


def test_signed_premium_is_verified_and_cannot_be_reused(client, monkeypatch):
    seen = []
    async def fake_verify(sig, payer, min_lamports): seen.append((sig, payer, min_lamports))
    monkeypatch.setattr(main, "verify_premium", fake_verify)
    body = dict(BODY, premium_tx_signature="user-sig-1", premium_payer=PAYER)
    assert client.post("/policy", json=body).status_code == 201
    assert seen == [("user-sig-1", PAYER, 30_000_000)]
    again = client.post("/policy", json=body)
    assert again.status_code == 409 and "already been used" in again.json()["detail"]


def test_rejected_signed_premium_creates_nothing(client, monkeypatch):
    async def bad(sig, payer, min_lamports): raise PremiumError("That transaction is not a premium payment.")
    monkeypatch.setattr(main, "verify_premium", bad)
    r = client.post("/policy", json=dict(BODY, premium_tx_signature="forged", premium_payer=PAYER))
    assert r.status_code == 402
    assert client.get("/policy").json()["policies"] == []
