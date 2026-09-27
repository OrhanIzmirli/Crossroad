"""The dollar labels must survive CoinGecko rate limits: the last known SOL price keeps being served."""

import httpx
from fastapi.testclient import TestClient

import app.main as main


class _Resp:
    def __init__(self, usd): self.usd = usd
    def raise_for_status(self):
        if self.usd is None: raise httpx.HTTPStatusError("429", request=None, response=None)
    def json(self): return {"solana": {"usd": self.usd}}


def test_price_is_cached_and_survives_a_rate_limit(monkeypatch):
    replies = [123.4, None]
    async def get(self, url, params=None, **kw): return _Resp(replies.pop(0))
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    monkeypatch.setattr(main, "_sol_price", {"usd": None, "fetched_at": 0.0})
    c = TestClient(main.app)
    assert c.get("/sol-price").json()["usd"] == 123.4
    assert c.get("/sol-price").json()["usd"] == 123.4 and replies == [None]      # cached: CoinGecko not asked again
    main._sol_price["fetched_at"] = 0.0                                            # cache expired, CoinGecko now fails
    assert c.get("/sol-price").json()["usd"] == 123.4 and replies == []          # last known price still served
