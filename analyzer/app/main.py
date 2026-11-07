"""
AI LeadGen — Website Analyzer (FastAPI)

Fetches a business's public website politely (robots.txt respected, max 3 pages,
same domain only, SSRF-protected) and extracts objective signals used for lead scoring.
It never guesses contacts: only addresses literally published on the site are returned,
each with the page it was found on.
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import socket
import time
from typing import Optional
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

USER_AGENT = os.getenv("ANALYZER_USER_AGENT", "AILeadGenBot/1.0 (+https://leadgen.example/bot)")
TOKEN = os.getenv("ANALYZER_TOKEN", "")
TIMEOUT = float(os.getenv("ANALYZER_TIMEOUT", "12"))
MAX_BYTES = 2_000_000
MAX_PAGES = 3

app = FastAPI(title="AI LeadGen Website Analyzer", version="1.0.0")


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="Invalid token")


class AnalyzeRequest(BaseModel):
    url: str = Field(..., max_length=500)


# --------------------------------------------------------------------------- safety
def _is_public_host(host: str) -> bool:
    """Block SSRF to internal networks: every resolved address must be public."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


def normalize_url(raw: str) -> str:
    raw = raw.strip()
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    p = urlparse(raw)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError("Invalid URL")
    return raw


# --------------------------------------------------------------------------- extraction
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}")
BAD_EMAIL = re.compile(r"\.(png|jpe?g|gif|webp|svg|css|js)$|@(example\.|sentry|wixpress|domain\.com|email\.com)|^(u00|your|name@)", re.I)

TECH_SIGNATURES = {
    "WordPress": [r"wp-content", r"wp-includes"],
    "Shopify": [r"cdn\.shopify\.com", r"Shopify\.theme"],
    "Wix": [r"static\.wixstatic\.com", r"wix\.com"],
    "Squarespace": [r"squarespace"],
    "Webflow": [r"webflow"],
    "WooCommerce": [r"woocommerce"],
    "React": [r"__NEXT_DATA__|data-reactroot|react-dom"],
    "Next.js": [r"__NEXT_DATA__|/_next/"],
    "Bootstrap": [r"bootstrap(\.min)?\.(css|js)"],
    "jQuery": [r"jquery(\.min)?\.js"],
    "Google Analytics": [r"googletagmanager\.com/gtag|google-analytics\.com"],
    "Google Tag Manager": [r"googletagmanager\.com/gtm"],
    "Meta Pixel": [r"connect\.facebook\.net/.+/fbevents"],
    "Cloudflare": [r"cdn-cgi/"],
}
CHAT_RE = re.compile(r"tawk\.to|intercom|crisp\.chat|zendesk|livechat|freshchat|drift\.com|tidio", re.I)
BOOKING_RE = re.compile(r"\b(book (an )?appointment|book now|reserve|reservation|schedule (a )?(call|visit)|calendly|practo|zocdoc)\b", re.I)
ECOM_RE = re.compile(r"add to cart|checkout|woocommerce|cdn\.shopify|/cart\b", re.I)
SOCIAL = {"facebook": "facebook.com", "instagram": "instagram.com", "linkedin": "linkedin.com", "twitter": "twitter.com|x.com", "youtube": "youtube.com"}


def _clean_email(e: str) -> Optional[str]:
    e = e.strip().strip(".").lower()
    if BAD_EMAIL.search(e) or len(e) > 120:
        return None
    return e


def extract(html: str, url: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.extract()
    text = soup.get_text(" ", strip=True)
    emails, phones = set(), set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("mailto:"):
            e = _clean_email(href[7:].split("?")[0])
            if e:
                emails.add(e)
        elif href.lower().startswith("tel:"):
            phones.add(re.sub(r"[^\d+]", "", href[4:]))
    for m in EMAIL_RE.findall(text):
        e = _clean_email(m)
        if e:
            emails.add(e)
    return {"soup": soup, "text": text, "emails": emails, "phones": {p for p in phones if len(p) >= 7}}


class Page:
    """Size-capped response snapshot."""

    def __init__(self, status_code: int, headers: httpx.Headers, url: httpx.URL, content: bytes, encoding: str):
        self.status_code, self.headers, self.url, self.content = status_code, headers, url, content
        self.text = content.decode(encoding, errors="replace")


class Fetcher:
    def __init__(self, client: httpx.AsyncClient):
        self.client = client
        self.robots: dict[str, RobotFileParser] = {}

    async def allowed(self, url: str) -> bool:
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self.robots:
            rp = RobotFileParser()
            try:
                r = await self.client.get(base + "/robots.txt")
                rp.parse(r.text.splitlines() if r.status_code == 200 else [])
            except httpx.HTTPError:
                rp.parse([])
            self.robots[base] = rp
        return self.robots[base].can_fetch(USER_AGENT, url)

    async def get(self, url: str) -> tuple[Optional["Page"], float]:
        if not _is_public_host(urlparse(url).hostname or ""):
            raise PermissionError("Host resolves to a non-public address")
        t0 = time.perf_counter()
        async with self.client.stream("GET", url) as r:
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) > MAX_BYTES:
                    break
            page = Page(r.status_code, r.headers, r.url, body, r.encoding or "utf-8")
        # Re-check the final host after redirects
        if not _is_public_host(page.url.host or ""):
            raise PermissionError("Redirected to a non-public address")
        return page, (time.perf_counter() - t0) * 1000


def analyse_homepage(html: str, resp: "Page", load_ms: float) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    raw = html
    title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
    desc_tag = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
    desc = (desc_tag.get("content") or "").strip() if desc_tag else ""
    h1 = [h.get_text(" ", strip=True) for h in soup.find_all("h1")][:5]
    viewport = bool(soup.find("meta", attrs={"name": re.compile("^viewport$", re.I)}))
    techs = [name for name, pats in TECH_SIGNATURES.items() if any(re.search(p, raw, re.I) for p in pats)]
    social = {}
    for a in soup.find_all("a", href=True):
        for k, dom in SOCIAL.items():
            if k not in social and re.search(dom, a["href"], re.I):
                social[k] = a["href"]
    imgs = soup.find_all("img")
    missing_alt = sum(1 for i in imgs if not i.get("alt"))
    issues = []
    if not title:
        issues.append("Missing <title>")
    elif len(title) > 65:
        issues.append("Title longer than 65 characters")
    if not desc:
        issues.append("Missing meta description")
    if not h1:
        issues.append("Missing H1 heading")
    elif len(h1) > 1:
        issues.append("Multiple H1 headings")
    if imgs and missing_alt / len(imgs) > 0.3:
        issues.append(f"{missing_alt}/{len(imgs)} images missing alt text")
    if not soup.find("link", attrs={"rel": re.compile("canonical", re.I)}):
        issues.append("No canonical URL")
    text = soup.get_text(" ", strip=True)
    years = [int(y) for y in re.findall(r"(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2}|19\d{2})", raw, re.I)]
    return {
        "https": str(resp.url).startswith("https://"),
        "status_code": resp.status_code,
        "load_ms": round(load_ms),
        "page_size_kb": round(len(resp.content) / 1024, 1),
        "title": title[:200],
        "meta_description": desc[:300],
        "h1": h1,
        "word_count": len(text.split()),
        "has_viewport": viewport,
        "technologies": techs,
        "has_analytics": any(t in techs for t in ("Google Analytics", "Google Tag Manager", "Meta Pixel")),
        "has_contact_form": bool(soup.find("form") and re.search(r"(email|message|phone)", str(soup.find("form")), re.I)),
        "has_booking": bool(BOOKING_RE.search(text)),
        "has_ecommerce": bool(ECOM_RE.search(raw)),
        "has_chat_widget": bool(CHAT_RE.search(raw)),
        "has_whatsapp": bool(re.search(r"wa\.me/|api\.whatsapp\.com", raw, re.I)),
        "social_links": social,
        "seo_issues": issues,
        "copyright_year": max(years) if years else None,
    }


def contact_pages(soup: BeautifulSoup, base: str) -> list[str]:
    host = urlparse(base).hostname
    out = []
    for a in soup.find_all("a", href=True):
        label = (a.get_text(" ", strip=True) + " " + a["href"]).lower()
        if re.search(r"contact|about|reach|enquir", label):
            u = urljoin(base, a["href"]).split("#")[0]
            if urlparse(u).hostname == host and u not in out and u.rstrip("/") != base.rstrip("/"):
                out.append(u)
    return out[: MAX_PAGES - 1]


async def analyse(url: str) -> dict:
    try:
        url = normalize_url(url)
    except ValueError as e:
        return {"ok": False, "url": url, "error": str(e)}
    async with httpx.AsyncClient(headers={"User-Agent": USER_AGENT, "Accept": "text/html"}, timeout=TIMEOUT, follow_redirects=True, max_redirects=5) as client:
        f = Fetcher(client)
        try:
            if not await f.allowed(url):
                return {"ok": False, "url": url, "robots_allowed": False, "error": "Disallowed by robots.txt"}
            resp, load_ms = await f.get(url)
        except PermissionError as e:
            return {"ok": False, "url": url, "error": str(e)}
        except httpx.HTTPError as e:
            # Retry over plain HTTP if HTTPS failed — itself a finding
            if url.startswith("https://"):
                try:
                    url = "http://" + url[8:]
                    resp, load_ms = await f.get(url)
                except Exception:
                    return {"ok": False, "url": url, "error": f"Unreachable: {type(e).__name__}"}
            else:
                return {"ok": False, "url": url, "error": f"Unreachable: {type(e).__name__}"}
        if resp is None or resp.status_code >= 400:
            return {"ok": False, "url": url, "status_code": getattr(resp, "status_code", None), "error": f"HTTP {getattr(resp, 'status_code', '?')}"}
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype:
            return {"ok": False, "url": url, "error": f"Not an HTML page ({ctype[:40]})"}

        html = resp.text
        result = {"ok": True, "url": url, "final_url": str(resp.url), "robots_allowed": True, **analyse_homepage(html, resp, load_ms)}
        home = extract(html, str(resp.url))
        emails = {e: str(resp.url) for e in home["emails"]}
        phones = {p: str(resp.url) for p in home["phones"]}
        pages = [str(resp.url)]
        for page in contact_pages(home["soup"], str(resp.url)):
            try:
                if not await f.allowed(page):
                    continue
                r2, _ = await f.get(page)
                if r2 is not None and r2.status_code < 400 and "html" in r2.headers.get("content-type", ""):
                    ex = extract(r2.text, page)
                    for e in ex["emails"]:
                        emails.setdefault(e, page)
                    for p in ex["phones"]:
                        phones.setdefault(p, page)
                    pages.append(page)
                    if ex["soup"].find("form"):
                        result["has_contact_form"] = True
            except Exception:
                continue
            await asyncio.sleep(0.5)  # be polite
        site_host = (resp.url.host or "").replace("www.", "")
        # Prefer addresses on the business's own domain; keep others (e.g. gmail) but list them after
        ordered = sorted(emails.items(), key=lambda kv: 0 if kv[0].endswith(site_host) else 1)
        result["emails"] = [{"value": e, "page": p} for e, p in ordered][:10]
        result["phones"] = [{"value": p, "page": pg} for p, pg in phones.items()][:10]
        result["pages_checked"] = pages
        return result


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "service": "analyzer"}


@app.post("/analyze", dependencies=[Depends(require_token)])
async def analyze_endpoint(req: AnalyzeRequest) -> dict:
    try:
        return await asyncio.wait_for(analyse(req.url), timeout=40)
    except asyncio.TimeoutError:
        return {"ok": False, "url": req.url, "error": "Analysis timed out"}
