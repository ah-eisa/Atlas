"""Tests for multi-currency handling.

The dashboard is meant to work for an investor reporting in any currency, with
holdings quoted in any number of others. These pin the conversion rules so a
portfolio does not silently come out 100x too large (the pence trap) or
inverted (the pair-direction trap).
"""

from __future__ import annotations

import pytest

from backend.app.data import MINOR_UNITS, fx_symbol, normalise_currency


def test_fx_symbol_follows_yahoo_pair_convention() -> None:
    """`{FROM}{TO}=X` is quoted as TO per 1 FROM."""
    assert fx_symbol("USD", "EUR") == "USDEUR=X"
    assert fx_symbol("EUR", "USD") == "EURUSD=X"
    assert fx_symbol("CHF", "GBP") == "CHFGBP=X"


def test_major_currencies_pass_through_unscaled() -> None:
    for code in ("EUR", "USD", "GBP", "CHF", "JPY", "SEK"):
        assert normalise_currency(code) == (code, 1.0)


def test_pence_are_normalised_to_pounds() -> None:
    """London quotes in GBp; treating it as GBP would overstate 100x."""
    assert normalise_currency("GBp") == ("GBP", 0.01)


def test_every_minor_unit_maps_to_a_distinct_major_unit() -> None:
    for minor, (major, factor) in MINOR_UNITS.items():
        assert minor != major
        assert 0 < factor < 1


def test_minor_unit_conversion_is_applied_to_price() -> None:
    """A 250p London quote is 2.50 GBP."""
    _, factor = normalise_currency("GBp")
    assert 250.0 * factor == pytest.approx(2.50)


def test_unknown_currency_is_passed_through_rather_than_guessed() -> None:
    """An unrecognised code must not be silently rescaled."""
    assert normalise_currency("XYZ") == ("XYZ", 1.0)


def test_market_data_rate_series_is_unity_for_the_base_currency(synthetic_market) -> None:
    rates = synthetic_market.rate_series("EUR")
    assert len(rates) == len(synthetic_market.prices_base)
    assert set(rates.unique()) == {1.0}


def test_market_data_rate_series_returns_the_foreign_pair(synthetic_market) -> None:
    rates = synthetic_market.rate_series("USD")
    assert rates.equals(synthetic_market.fx["USD"])


def test_market_data_rate_series_rejects_an_unloaded_currency(synthetic_market) -> None:
    with pytest.raises(KeyError):
        synthetic_market.rate_series("JPY")
