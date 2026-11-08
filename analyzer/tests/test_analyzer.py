import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import main
from app.main import app

HOME = """<html><head><title>Sunrise Dental</title></head><body>
<h1>Welcome</h1><img src="a.png"><img src="b.png">
<a href="/contact-us">Contact</a> <a href="https://facebook.com/sunrise">FB</a>
<script src="/wp-content/themes/x.js"></script>
<p>Book an appointment today. &copy; 2019 Sunrise</p>
<a href="mailto:info@sunrisedental.test">Email us</a>
</body></html>"""
CONTACT = """<html><body><form><input name="email"><textarea name="message"></textarea></form>
Reach us at bookings@sunrisedental.test or call <a href="tel:+91 98765 43210">us</a>. logo@2x.png</body></html>"""


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(main, "_is_public_host", lambda h: h != "internal.test")


@respx.mock
def test_extracts_published_signals_only():
    respx.get("https://sunrisedental.test/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *\nAllow: /"))
    respx.get(url__regex=r"^https://sunrisedental\.test/?$").mock(return_value=httpx.Response(200, html=HOME))
    respx.get("https://sunrisedental.test/contact-us").mock(return_value=httpx.Response(200, html=CONTACT))
    r = TestClient(app).post("/analyze", json={"url": "sunrisedental.test"}).json()
    assert r["ok"] is True
    assert r["has_viewport"] is False
    assert "WordPress" in r["technologies"]
    assert "Missing meta description" in r["seo_issues"]
    assert r["copyright_year"] == 2019
    assert r["has_booking"] is True and r["has_contact_form"] is True
    values = {e["value"]: e["page"] for e in r["emails"]}
    assert values == {"info@sunrisedental.test": "https://sunrisedental.test", "bookings@sunrisedental.test": "https://sunrisedental.test/contact-us"}
    assert r["phones"][0]["value"] == "+919876543210"
    assert r["social_links"]["facebook"].startswith("https://facebook.com")


@respx.mock
def test_respects_robots_txt():
    respx.get("https://blocked.test/robots.txt").mock(return_value=httpx.Response(200, text="User-agent: *\nDisallow: /"))
    r = TestClient(app).post("/analyze", json={"url": "https://blocked.test"}).json()
    assert r["ok"] is False and r["robots_allowed"] is False


def test_blocks_internal_hosts():
    r = TestClient(app).post("/analyze", json={"url": "http://internal.test/admin"}).json()
    assert r["ok"] is False


def test_reports_dead_domain(monkeypatch):
    def nx(h):
        raise main.DomainNotFound(f"Domain does not resolve (ENOTFOUND {h})")
    monkeypatch.setattr(main, "_is_public_host", nx)
    r = TestClient(app).post("/analyze", json={"url": "gone.test"}).json()
    assert r["ok"] is False and "ENOTFOUND" in r["error"]


def test_rejects_bad_scheme():
    r = TestClient(app).post("/analyze", json={"url": "ftp://x.test"}).json()
    assert r["ok"] is False


def test_token_required(monkeypatch):
    monkeypatch.setattr(main, "TOKEN", "abc")
    assert TestClient(app).post("/analyze", json={"url": "x.test"}).status_code == 401
