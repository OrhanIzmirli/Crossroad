"""End to end: the median of the sources is paid once, in full; nothing is held and nobody has to approve it."""

import time

import pytest
from fastapi.testclient import TestClient

import app.escrow as escrow_mod
import app.main as main
import app.payment as pay
import app.policy_store as store

PAYEE = "GYwymMhybDFa5iJeAPxZGGdNG1EfPNhTZQa9u2dXbuTo"


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "STORE_PATH", tmp_path / "policies.json")
    monkeypatch.setattr(escrow_mod, "LEDGER_PATH", tmp_path / "escrow_ledger.json")
    monkeypatch.setattr("app.decision._secret", lambda name: "")       # rule-based explanation, no network
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    sends = []
    async def fake_send(amount, to):
        sends.append(amount)
        return pay.PaymentResult(success=True, tx_signature=f"tx{len(sends)}", amount_sol=amount, to_address=to, confirmed_at=time.time())
    async def fake_premium(amount_sol): return "premium-sig"
    monkeypatch.setattr(main, "send_payment", fake_send)
    monkeypatch.setattr(main, "collect_demo_premium", fake_premium)
    return TestClient(main.app), sends


def _policy(c):
    r = c.post("/policy", json={"region": "Warsaw", "lat": 52.23, "lon": 21.01, "sum_insured_sol": 0.01, "product_type": "crop_drought", "payee_pubkey": PAYEE})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_an_outlier_source_is_outvoted_and_paid_in_one_go(client):
    c, sends = client
    pid = _policy(c)
    # drought rule 40 -> 10 mm: 32.5 mm = 0.25, 14.5 mm = 0.85 (the outlier), 31 mm = 0.30 -> median 0.30
    r = c.post(f"/policy/{pid}/evaluate", json={"simulate": [{"mm": 32.5, "label": "A"}, {"mm": 14.5, "label": "B"}, {"mm": 31, "label": "C"}]})
    assert r.status_code == 200, r.text
    ev = r.json()
    assert ev["payout_ratio_settled"] == pytest.approx(0.30) and ev["paid_amount_sol"] == pytest.approx(0.003)
    assert sends == [pytest.approx(0.003)]                                   # exactly one payment, the median
    assert ev["dispute_status"] == "resolved" and ev["escrow"] is None and ev["escrow_amount_sol"] == 0
    assert ev["dispute"]["summary"].endswith("was paid in full at once; nothing is held back.")
    assert ev["proof"]["settled_calc"].startswith("paid    = median(")
    assert ev["explanation"]["plain"].startswith("The sources gave different answers: 32.5 mm, 14.5 mm, 31.0 mm.")
    assert c.post(f"/policy/{pid}/evaluate", json={"simulate": [{"mm": 5}]}).status_code == 409   # settled: no second cycle


def test_agreeing_sources_are_paid_with_a_plain_explanation(client):
    c, sends = client
    pid = _policy(c)
    ev = c.post(f"/policy/{pid}/evaluate", json={"simulate": [{"mm": 25, "label": "A"}, {"mm": 26, "label": "B"}, {"mm": 24, "label": "C"}]}).json()
    assert ev["dispute_status"] == "none" and ev["dispute"] is None and sends == [pytest.approx(0.005)]
    assert ev["explanation"] == {"plain": "The sources reported 25.0 mm, 26.0 mm, 24.0 mm. The middle one, 25 mm, is between 40 mm, where payment starts, and 10 mm, where you get everything, so 50% of the cover is paid.",
                                 "ai_used": False, "model": "rule-based",
                                 "bottom_line": "The middle report, 25 mm, is between 40 mm, where payment starts, and 10 mm, where you get everything, so 50% of the cover is paid."}


def test_no_payout_explanation_names_the_middle_report(client):
    c, sends = client
    r = c.post("/policy", json={"region": "X", "lat": 52.2, "lon": 21.0, "sum_insured_sol": 0.01, "product_type": "travel_delay", "payee_pubkey": PAYEE})
    ev = c.post(f"/policy/{r.json()['id']}/evaluate", json={"simulate": [{"mm": 9.8, "label": "delay-feed-A"}, {"mm": 20, "label": "delay-feed-B"}, {"mm": 13.5, "label": "delay-feed-C"}]}).json()
    assert sends == [] and ev["paid_amount_sol"] == 0
    assert "The middle one, 13.5 min, does not reach the 30 min point where payment starts, so nothing is owed." in ev["explanation"]["plain"]
    assert ev["explanation"]["bottom_line"] == "The middle report, 13.5 min, does not reach the 30 min point where payment starts, so nothing is owed."
