"""Run: python cloud/format_cards_browser_check.py. Synthetic check (design opmaak-editor, phase 1): a Markdown table
shows as a small real table on its card (3 columns, the header and 3 rows, the rest in words), whole or not at all, and
in full on the page of a note shared by link, where a wide table scrolls inside its own frame and the page does not."""
import json
import sys
sys.dont_write_bytecode = True
from browser_check import main

TABLE = "\n".join([
    "| Número | Serie | Fracción | Precio | Comprado en | Fecha | Para | Notas |",
    "|---|:-:|--:|---|---|---|---|---|",
    "| 12345 | 101 | 3 | **20 €** | Administración 7 | 2026-10-02 | Katharina | Regalo |",
    "| 67890 | 45 | 1 | 20 € | [Online](https://example.com/loteria) | 2026-10-15 | Matěj | a \\| b |",
    "| 24680 | 12 | 7 | 20 € | Bar Pepe | 2026-11-01 | Familia | una<br>dos |",
    "| 13579 | 88 | 2 | 20 € | Estanco | 2026-11-03 |  |  |",
    "| 11223 | 9 | 5 | 20 € | Online | 2026-11-10 | Katharina | Una nota muy larga que no cabe en la celda |",
])
NOTE = f"# Lotería de Navidad\n\n## Décimos sueltos\n\n{TABLE}\n\nTotal: 100 €"
SMALL = "# Small table\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] not a checklist card"
CODE = "# Code table\n\n```\n| x | y |\n|---|---|\n```"


def check_format_cards(browser, url, token):
    context = browser.new_context(viewport={"width": 1200, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("response", lambda response: errors.append(f"{response.status} {response.url}") if response.status >= 400 and "/api/" not in response.url else None)
    try:
        page.goto(url, wait_until="networkidle")
        page.locator("#show-connect").click()
        page.locator("#access-code").fill(token)
        for field in ["#new-password", "#confirm-password"]:
            page.locator(field).fill("synthetic long passphrase")
        page.locator('#connect-form button[type="submit"]').click()
        page.locator("#recovery-saved").check()
        page.locator("#finish-recovery").click()
        page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()
        for name, text in [("Loteria", NOTE), ("Small", SMALL), ("Code", CODE)]:
            page.locator("#new-note").click()
            page.locator("#note-path").fill(f"notes/2026-11-16 1200{len(name):02d} {name}.md")
            page.locator("#note-content").fill(text)
            page.locator('#editor-form button[type="submit"]').click()
            page.locator("#sync-status").filter(has_text="Cloud copy up to date").wait_for()

        card = page.locator(".note-card").filter(has_text="Lotería de Navidad").first
        table = card.locator(".jd-card-table table")
        table.wait_for()
        # 3 columns, the header and 3 rows; cells are plain text without Markdown signs.
        assert table.locator("thead th").all_inner_texts() == ["Número", "Serie", "Fracción"], table.locator("thead th").all_inner_texts()
        assert table.locator("tbody tr").count() == 3
        assert table.locator("tbody tr").nth(0).locator("td").all_inner_texts() == ["12345", "101", "3"]
        assert card.locator(".jd-table-more").inner_text() == "+ 5 columns · + 2 rows", card.locator(".jd-table-more").inner_text()
        assert "|" not in card.locator(".compact-card-preview").inner_text() and "---" not in card.locator(".compact-card-preview").inner_text()
        # Alignment from the delimiter row, as a class (the CSP allows no inline style from markup).
        assert table.locator("thead th").nth(1).get_attribute("class") == "jd-align-center"
        assert table.locator("thead th").nth(2).get_attribute("class") == "jd-align-right"
        # The text around the table stays, in its own order; what no longer fits under it is behind "Open note".
        preview = card.locator(".compact-card-preview").inner_text()
        assert preview.index("Décimos sueltos") < preview.index("Número"), preview
        assert preview.index("Número") < preview.find("Total: 100 €") or card.locator('[data-preview-action="open"]').is_visible(), preview
        # The table fits the card: no sideways overflow, cells end in "…" instead.
        sizes = card.evaluate("(el) => { const t = el.querySelector('.jd-card-table'); return { box: t.clientWidth, scroll: t.scrollWidth, card: el.clientWidth, cell: getComputedStyle(t.querySelector('td')).textOverflow }; }")
        assert sizes["scroll"] <= sizes["box"] + 1 and sizes["box"] <= sizes["card"], sizes
        assert sizes["cell"] == "ellipsis", sizes

        small = page.locator(".note-card").filter(has_text="Small table").first
        assert small.locator(".jd-card-table tbody tr").count() == 1
        assert small.locator(".jd-table-more").count() == 0
        # A note with a table is never a checklist card; its task is a real box on a mixed card (design kaarten-en-lijsten).
        assert small.locator(".compact-card-preview").get_attribute("data-mode") == "mixed"
        assert small.get_by_role("checkbox", name="not a checklist card", exact=True).count() == 1, small.inner_text()
        assert "☐" not in small.inner_text(), small.inner_text()
        code = page.locator(".note-card").filter(has_text="Code table").first
        assert code.locator(".jd-card-table").count() == 0

        # A table that does not fit the card's height goes whole, and "Open note" shows.
        page.set_viewport_size({"width": 1200, "height": 300})
        page.wait_for_function("() => { const card = [...document.querySelectorAll('.note-card')].find(el => el.textContent.includes('Lotería')); return card && !card.querySelector('.jd-card-table'); }")
        assert card.locator('[data-preview-action="open"]').is_visible()
        page.set_viewport_size({"width": 1200, "height": 900})
        table.wait_for()

        # Shared by link: the whole table, scrolling inside its frame on a phone; the page itself does not scroll sideways.
        # Making a real link needs an account with a mail code (sharing_browser_check.py covers that), so here the link
        # module answers with the note; the page, its table code and the server's file list are the real ones.
        address = f"{url}/n/00000000-0000-4000-8000-000000000000#{'k' * 43}"
        stub = "export const readLinkAddress = () => ({ id: 'x', key: 'k' }); export const reportLink = async () => {}; export const openLink = async () => (%s);" % json.dumps({"title": "Lotería de Navidad", "text": NOTE.split("\n", 2)[2]})
        stranger = browser.new_context(viewport={"width": 390, "height": 800})
        reader = stranger.new_page()
        reader.route("**/shared/links.mjs", lambda route: route.fulfill(status=200, content_type="text/javascript", body=stub))
        reader.on("pageerror", lambda error: errors.append(str(error)))
        reader.on("response", lambda response: errors.append(f"{response.status} {response.url}") if response.status >= 400 and "/api/" not in response.url else None)
        reader.goto(address, wait_until="networkidle")
        reader.locator("#note-article").wait_for()
        full = reader.locator(".jd-note-table table")
        assert full.locator("thead th").count() == 8
        assert full.locator("tbody tr").count() == 5
        cells = full.locator("tbody tr").nth(1).locator("td").all_inner_texts()
        assert cells[7] == "a | b", cells
        assert full.locator("tbody tr").nth(2).locator("td").nth(7).locator("br").count() == 1
        assert reader.locator("#note-body p").filter(has_text="Total: 100 €").count() == 1
        frame = reader.evaluate("() => { const box = document.querySelector('.jd-note-table'); return { scroll: box.scrollWidth, box: box.clientWidth, page: document.documentElement.scrollWidth, view: window.innerWidth, first: getComputedStyle(box.querySelector('td')).position }; }")
        assert frame["scroll"] > frame["box"], frame
        widths = reader.evaluate("() => [...document.querySelectorAll('.jd-note-table tbody tr:last-child td')].map((td) => Math.round(td.getBoundingClientRect().width))")
        assert max(widths) <= 222, widths
        assert frame["page"] <= frame["view"], frame
        assert frame["first"] == "sticky", frame
        stranger.close()
        assert not errors, errors
        return {"card_table_3x3": True, "more_in_words": True, "never_checklist": True, "mixed_with_table": True, "code_stays_code": True, "whole_or_gone": True, "shared_page_full_table": True, "page_no_sideways_scroll": True}
    finally:
        context.close()


if __name__ == "__main__":
    main(check_format_cards)
