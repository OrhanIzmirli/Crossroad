"""The customer-facing explanation must be jargon-free and must never state money amounts."""

from app.decision import _plain


def test_clean_everyday_sentences_are_kept():
    text = "One forecast says 73 mm of rain, the other says 103 mm. A person will check before the rest is paid."
    assert _plain(text) == text


def test_jargon_or_amounts_are_rejected():
    for bad in ["The floor was paid immediately.", "The payout ratio spread is large.", "0.1017 SOL was sent.",
                "The rest sits in escrow.", "Both readings were simulated."]:
        assert _plain(bad) == "", bad


def test_missing_or_rambling_text_is_rejected():
    assert _plain(None) == "" and _plain("   ") == "" and _plain("word " * 150) == ""
