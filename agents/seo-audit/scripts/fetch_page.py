#!/usr/bin/env python3
"""Fetch one web page and report what an SEO audit reads from it.

Input  (stdin JSON):  { "url": "https://example.com/" }
Output (stdout JSON): { url, final_url, status, content_type, bytes_read, truncated,
                        title, meta_description, h1, h2, link_count,
                        record_file | record_error }
                  or  { "error": "..." } when the page could not be fetched.

What it read is also saved, when the page was read: RECORD_FILE, a fixed name in
the run's output directory (SKRUN_OUTPUT_DIR), holds the requested and final URL,
the status, the content type, the title, the size read, and the page's text — its
first RECORD_MAX_CHARS characters. The file is one of the run's files: it shows
what the tool really read. A second read in the same run replaces it; nothing is
written when the page could not be fetched, and nothing anywhere else.

Standard library only (urllib, html.parser): the agent ships no manifest, and no
dependency is installed for it. Bounded on purpose:
  - http and https only, redirects included — never file:, ftp: or anything else;
  - a host that resolves to a private, loopback, link-local or otherwise reserved
    address is refused, so the tool means to read public pages only. Each
    connection resolves the host once, checks every address it gets, and connects
    to the address it checked — a name that answers a public address to the check
    and a private one a moment later reaches nothing. For https, the certificate
    is still verified against the host name, sent as SNI. No proxy is used: a
    proxy would resolve the name itself. In the cloud sandbox the network rules
    hold as well; elsewhere this check is the only guard;
  - at most MAX_BYTES of the body are read, and the request gives up after
    TIMEOUT_S seconds.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

MAX_BYTES = 1_000_000
TIMEOUT_S = 15
MAX_HEADINGS = 20
MAX_TEXT = 300
USER_AGENT = "skrun-seo-audit/1.1"
ALLOWED_SCHEMES = ("http", "https")
RECORD_FILE = "fetched-page.json"
# Enough for a page's head and the start of its body, a fraction of the 1 MB read.
RECORD_MAX_CHARS = 50_000
TEXT_TYPES = ("html", "text", "xml", "json")


class Refused(Exception):
    """A URL this tool will not fetch."""


def check_url(url: str) -> None:
    """Refuse anything but an http(s) URL with a host. Its addresses are checked
    where the connection is made, by public_address."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ALLOWED_SCHEMES:
        raise Refused(f"only http and https URLs are fetched (got scheme '{parts.scheme}')")
    if not parts.hostname:
        raise Refused("the URL has no host")


def public_address(host: str, port: int) -> str:
    """Resolve `host` once; refuse it unless every address is public, and return
    the address to connect to — the one that was checked."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise Refused(f"the host does not resolve: {exc}") from exc
    if not infos:
        raise Refused("the host does not resolve")
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        if not address.is_global or address.is_multicast:
            raise Refused("the host resolves to a non-public address")
    return infos[0][4][0]


def connect_public(address, *args, **kwargs):
    """socket.create_connection, on the address public_address checked — never
    on the name, which would be resolved a second time."""
    host, port = address[0], address[1]
    return socket.create_connection((public_address(host, port), port), *args, **kwargs)


class PublicHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect_public


class PublicHTTPSConnection(http.client.HTTPSConnection):
    """The TLS layer still gets the host name: SNI, and the certificate check."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = connect_public


class PublicHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(PublicHTTPConnection, req)


class PublicHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self):
        super().__init__(context=ssl.create_default_context())

    def https_open(self, req):
        return self.do_open(PublicHTTPSConnection, req, context=self._context)


class PublicOnlyRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to a URL check_url accepts; its connection is
    checked like the first."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802 - stdlib name
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class PageReader(HTMLParser):
    """Collects the title, the meta description, h1/h2 texts and the links."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta_description: str | None = None
        self.h1: list[str] = []
        self.h2: list[str] = []
        self.link_count = 0
        self._capture: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = {name.lower(): (value or "") for name, value in attrs}
        if tag == "meta" and attributes.get("name", "").lower() == "description":
            if self.meta_description is None:
                self.meta_description = attributes.get("content", "").strip()[:MAX_TEXT]
        elif tag == "a" and attributes.get("href"):
            self.link_count += 1
        elif tag in ("title", "h1", "h2") and self._capture is None:
            self._capture = tag
            self._text = []

    def handle_endtag(self, tag):
        if tag != self._capture:
            return
        text = " ".join("".join(self._text).split())[:MAX_TEXT]
        if tag == "title" and not self.title:
            self.title = text
        elif tag == "h1" and len(self.h1) < MAX_HEADINGS:
            self.h1.append(text)
        elif tag == "h2" and len(self.h2) < MAX_HEADINGS:
            self.h2.append(text)
        self._capture = None

    def handle_data(self, data):
        if self._capture is not None:
            self._text.append(data)


def page_text(body: bytes, content_type: str, charset: str) -> str | None:
    """The body as text, when its content type says it is text (or says
    nothing); None for anything else — an image, a PDF."""
    kind = content_type.lower()
    if kind and not any(text_type in kind for text_type in TEXT_TYPES):
        return None
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def fetch(url: str) -> tuple[dict, str | None]:
    """What an SEO audit reads from the page, and the page's text."""
    check_url(url)
    # No proxy (an empty ProxyHandler stands in for the default one, which reads
    # the environment), and connections that check the address they connect to.
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        PublicHTTPHandler(),
        PublicHTTPSHandler(),
        PublicOnlyRedirects(),
    )
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        response = opener.open(request, timeout=TIMEOUT_S)
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            # A redirect that was not followed: urllib itself refuses to leave
            # http(s), and loops end here too.
            exc.close()
            raise Refused(f"the page redirects ({exc.code}) to a URL this tool does not fetch") from exc
        # An error status is still a page to report on (a 404 has a title too).
        response = exc
    with response:
        body = response.read(MAX_BYTES + 1)
        status = response.status if hasattr(response, "status") else response.code
        final_url = response.geturl()
        content_type = response.headers.get("Content-Type", "")
        charset = response.headers.get_content_charset() or "utf-8"

    truncated = len(body) > MAX_BYTES
    body = body[:MAX_BYTES]
    text = page_text(body, content_type, charset)
    reader = PageReader()
    if text is not None and ("html" in content_type.lower() or not content_type):
        reader.feed(text)
        reader.close()

    result = {
        "url": url,
        "final_url": final_url,
        "status": status,
        "content_type": content_type,
        "bytes_read": len(body),
        "truncated": truncated,
        "title": reader.title,
        "meta_description": reader.meta_description,
        "h1": reader.h1,
        "h2": reader.h2,
        "link_count": reader.link_count,
    }
    return result, text


def save_record(result: dict, text: str | None) -> dict:
    """Write what was read to RECORD_FILE in the run's output directory. Returns
    the field the tool's answer gains: the file's name, or why it was not
    written; nothing when the runtime gave no output directory."""
    output_dir = os.environ.get("SKRUN_OUTPUT_DIR")
    if not output_dir:
        return {}
    record = {
        "url": result["url"],
        "final_url": result["final_url"],
        "status": result["status"],
        "content_type": result["content_type"],
        "title": result["title"],
        "bytes_read": result["bytes_read"],
        "content": None if text is None else text[:RECORD_MAX_CHARS],
        # True when `content` is all of the page: nothing cut here, nor at the 1 MB read.
        "content_complete": text is not None
        and len(text) <= RECORD_MAX_CHARS
        and not result["truncated"],
    }
    try:
        os.makedirs(output_dir, exist_ok=True)
        # A fixed name in that directory, never one taken from the URL; and never
        # through a link that would lead out of it.
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(os.path.join(output_dir, RECORD_FILE), flags, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8") as record_file:
            json.dump(record, record_file, ensure_ascii=False, indent=2)
    except OSError as exc:
        return {"record_error": f"what was read could not be saved: {exc}"}
    return {"record_file": RECORD_FILE}


def main() -> None:
    try:
        args = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        args = {}
    url = args.get("url") if isinstance(args, dict) else None
    if not isinstance(url, str) or not url.strip():
        print(json.dumps({"error": "missing 'url' (a string)"}))
        return
    try:
        result, text = fetch(url.strip())
    except Refused as exc:
        print(json.dumps({"error": f"refused: {exc}"}))
        return
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        print(json.dumps({"error": f"could not fetch the page: {exc}"}))
        return
    # The page was read: what was read is saved, then reported.
    result.update(save_record(result, text))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
