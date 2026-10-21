# GST Compliance Requirements and Boundaries

Status: Draft v0.1 · 2026-10-19 · **Not legal advice. Every item marked *Verify* or *Unresolved* requires review by a Chartered Accountant / GST practitioner before pilot.**

Status vocabulary: **Verified** (checked against a source listed in §7 on the date shown) · **Verified-secondary** (checked against a reputable transcription; primary not reachable from build environment) · **Recommended** (design choice) · **Assumed** · **Unresolved**.

## 1. Product position
The product **prepares** GST-compliant documents and summaries for supported
scenarios. In MVP it does **not** file returns, generate IRNs, or generate e-way
bills. It never presents an ordinary PDF or a UPI payment QR as an e-invoice.

## 2. Requirements matrix
| ID | Requirement | Product behaviour | Status | Source |
|---|---|---|---|---|
| GST-01 | Tax invoice serial number ≤ 16 characters; letters, digits, hyphen/dash, slash; unique per financial year; one or more series | Series formatter validates length/charset; new sequence per FY per registration; unique index | Verified-secondary | S1 |
| GST-02 | Tax invoice particulars (Rule 46 (a)–(s)) | Template fields per §4; validation blocks issue when mandatory fields are missing | Verified-secondary | S1 |
| GST-03 | Unregistered recipient with taxable supply ≥ ₹50,000: name, address, delivery address, state name and code required | Issue-time validation | Verified-secondary | S1 |
| GST-04 | HSN digits on tax invoices: AATO up to ₹5 crore → 4 digits; above ₹5 crore → 6 digits (B2C exemption for ≤ ₹5 crore per notification). 8 digits optional | Validation driven by the entity's declared turnover band (FR-CO-06) | Verified | S2 |
| GST-05 | E-invoices: ≥ 6-digit HSN for AATO ≥ ₹5 crore (IRP-side validation from 15-12-2023) | Enforced when e-invoice mode is enabled | Verified-secondary | S5 |
| GST-06 | E-invoicing applicable where aggregate turnover in any preceding FY from 2017-18 exceeds ₹5 crore (from 01-08-2023) | Applicability warning in settings; e-invoice integration deferred (§5) | Verified-secondary (no newer notification found 2026-10-19) | S3 |
| GST-07 | IRP reporting within 30 days of document date for AATO ≥ ₹10 crore (from 01-04-2025) | When integration ships: deadline tracking + alerts | Verified | S4 |
| GST-08 | Clause (s) declaration where an entity above the e-invoice threshold is exempt from e-invoicing | Configurable declaration text on template | Verified-secondary | S1 |
| GST-09 | Tax split: intra-state → CGST + SGST/UTGST; inter-state → IGST, based on supplier location and place of supply | Supported for scenarios in §3.1 | Recommended (logic), Verify (PoS rules) | IGST Act s.10, s.12 |
| GST-10 | Place of supply ≠ customer state in all cases (e.g. bill-to/ship-to, services rules) | Default from ship-to state for goods with movement; explicit field with audited override; services default to recipient registered state/address — limited scope | Unresolved (C-01) | IGST Act s.10–13 |
| GST-11 | Rates are not hard-coded; rates changed from 22-09-2025 (GST rate rationalisation: principal 5 % / 18 %, 40 % de-merit; 12 % and 28 % slabs removed) | Tenant-maintained effective-dated schedules; each schedule row records who verified it and the notification reference | Verified-secondary (structure); per-item rates **not** provided | S6 |
| GST-12 | Compensation cess changes (withdrawal for specified goods reported from 01-02-2026) | Cess supported as optional component on schedules; no defaults shipped | Unresolved (C-04) | S6 |
| GST-13 | Reverse charge only for notified categories / s.9(4) notified cases — not merely because supplier is unregistered | RCM flag only via explicit tax-class configuration; Rule 46(p) indicator printed | Recommended / Verify (C-02) | CGST Act s.9(3), 9(4) |
| GST-14 | Bill of supply for exempt supplies / composition dealers (Rule 49) | Document type `bill_of_supply` | Verify | CGST Rules r.49 |
| GST-15 | Credit/debit notes with reference to original invoice (s.34, Rule 53) | Linked notes; reason; time-limit warning | Verify (time limit: by 30 Nov following FY end — confirm) | CGST Act s.34 |
| GST-16 | Delivery challan for movement without supply (Rule 55) | `delivery_challan` document for transfers/job-work out (job-work accounting deferred) | Verify | CGST Rules r.55 |
| GST-17 | Receipt voucher for advances (Rule 50) and refund voucher (Rule 51) | Advance receipt documents; tax-on-advance for services **not** computed in MVP | Unresolved (C-06) | CGST Rules r.50–51 |
| GST-18 | Records retention (s.36: 72 months from due date of annual return) | 8-year default retention | Verify | CGST Act s.36 |
| GST-19 | UQC for quantities | Each unit maps to one of the 45 UQCs in the e-invoice portal master (S10); 14 default units seeded per business | Verified (S10, 2026-10-19) | S10 |
| GST-20 | E-way bill above ₹50,000 consignment value (Rule 138), state intra-state variations | Not generated in MVP; dispatch screen shows "E-way bill: not generated by this system" with field to record EWB number manually | Verified-secondary (secondary sources only) | Rule 138 |

## 3. Supported and unsupported scenarios

### 3.1 Supported in MVP (subject to CA review)
- Regular-registered supplier, domestic B2B and B2C supplies of goods and services.
- Intra-state and inter-state supplies within India with place of supply explicitly captured.
- Multiple GSTINs under one PAN with separate series.
- Exempt / nil-rated lines (bill of supply for wholly exempt invoices).
- Composition-registered supplier issuing bills of supply (no tax collected) — rate & declaration text configured by user.
- Purchases with ITC eligibility declared by the user (no ITC rule engine).
- Credit/debit notes linked to invoices; sales and purchase returns.

### 3.2 Not supported in MVP (blocked or warned)
Exports and SEZ supplies (with/without IGST), deemed exports, supplies to UIN holders,
e-commerce operator (s.9(5)/TCS) flows, online gaming, OIDAR, ISD, input service
distribution, job-work accounting, margin scheme / second-hand goods, tax on
advances for services, TDS/TCS under GST, reverse-charge self-invoicing
beyond recording, imports (IGST on BoE recorded only as purchase line), multi-currency,
GSTR-1/3B filing, ITC reconciliation with GSTR-2B. The UI blocks selection of
these where detectable (e.g. foreign country address) and explains why.

## 4. Document particulars
| Particular | Tax invoice | Bill of supply | Credit/Debit note | Delivery challan | Receipt voucher | Quotation / Proforma / PO / Statement |
|---|---|---|---|---|---|---|
| Supplier name, address, GSTIN | ● | ● | ● | ● | ● | ● (non-tax documents) |
| Serial no. (≤16) + date | ● | ● | ● | ● | ● | own series |
| Recipient name, address, GSTIN/UIN (if registered) | ● | ● | ● | ● | ● | ● |
| Unregistered ≥ ₹50,000: delivery address, state name & code | ● | ● | — | — | — | — |
| HSN/SAC per turnover band | ● | ● | ● | ● | — | optional |
| Description, qty + UQC | ● | ● | ● | ● | — | ● |
| Total value; taxable value after discount | ● | value | ● | value | ● | ● |
| Rate & amount: CGST/SGST/UTGST/IGST/cess | ● | — | ● | — (or as applicable) | ● | estimated, labelled "not a tax invoice" |
| Place of supply + state name (inter-state) | ● | ● | ● | ● | ● | — |
| Delivery address if different | ● | ● | — | ● | — | — |
| Reverse charge: Yes/No | ● | — | ● | — | ● | — |
| Signature / DSC (not needed for IT-Act e-invoice) | ● | ● | ● | ● | ● | optional |
| Original invoice ref & reason | — | — | ● | — | — | — |
| IRN + signed QR (only when actually registered on IRP) | when e-invoiced | — | when e-invoiced | — | — | — |
| Clause (s) declaration | when configured | — | — | — | — | — |
| Copy labels (Original for Recipient / Duplicate for Transporter / Triplicate for Supplier) — Rule 48 | ● | ● | — | ● | — | — |

Proforma invoices and quotations print **"This is not a tax invoice"**.

## 5. E-invoice and e-way-bill capability boundaries
- MVP ships provider **interfaces** (`EInvoiceProvider`, `EWayBillProvider`) with modes `disabled` (default) / `sandbox` / `live`.
- Access to IRP/NIC APIs requires registration via the e-invoice portal (direct API access has eligibility conditions) or a GSP/ASP contract — **no access assumed**; credentials, contracts and costs are not known (Unresolved C-07).
- Development/test may use `MockEInvoiceProvider`, which returns values prefixed `MOCK-` and is refused at startup in production.
- Document regulatory sub-state shown in UI: *Not applicable · Not submitted · Submitted · Registered (IRN) · Failed (reason) · Cancelled*. A PDF never shows IRN/QR unless state = Registered from a live provider.
- IRN cancellation window (24 h on IRP — verify) must be respected before allowing document cancellation once integration is live.

## 6. Payment QR
A UPI payment QR (if added) is labelled "Scan to pay" and is visually distinct from the e-invoice QR. It is never placed where an e-invoice QR is expected.

## 7. Official source register
| ID | Source | URL | Checked | Applicability |
|---|---|---|---|---|
| S1 | CGST Rules, Rule 46 (Tax invoice) — CBIC tax information portal | https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html | 2026-10-19: primary page failed TLS verification from build env; content checked via transcription at https://gstzen.in/a/tax-invoice-cgst-rule-46.html (amendments to Notif. 38/2023) | Current as transcribed |
| S2 | Notification 78/2020-Central Tax (HSN digits) | https://www.gstcouncil.gov.in/sites/default/files/2024-05/notfctn-78-central-tax-english-2020.pdf | 2026-10-19 (search summary of primary PDF) | From 01-04-2021 |
| S3 | Notification 10/2023-Central Tax (e-invoice ₹5 crore) | CBIC notifications (cited via EY alert https://www.ey.com/en_in/technical/alerts-hub/2023/05/cbic-lowers-turnover-threshold-for-e-invoicing-to-inr5-crores-with-effect-from-1-august-2023) | 2026-10-19 | From 01-08-2023 |
| S4 | GSTN advisory: 30-day IRP reporting limit for AATO ≥ ₹10 crore | https://www.mahagst.gov.in/public/uploads/gstnadvisory/1760531580_293%20Advisory%20Time%20Limit%20for%20Reporting%20e%20Invoice%20on%20the%20IRP%20Portal%20%20Lowering%20of%20Threshold%20to%20AATO%2010%20Crores%20and%20Above.pdf | 2026-10-19 | From 01-04-2025 |
| S5 | E-invoice system update: 6-digit HSN for AATO ≥ ₹5 crore | e-invoice portal update dated 05-12-2023 (via https://taxo.online/latest-news/05-12-2023-alteast-6-digit-hsn-mandatory-in-e-invoices-where-aato-is-rs-5-crores-or-more-from-15-12-2023-gst-e-invoice-system/) | 2026-10-19 | From 15-12-2023 |
| S6 | 56th GST Council rate rationalisation | GST Council press release (via EY alert https://www.ey.com/content/dam/ey-unified-site/ey-com/en-in/alerts-hub/2025/09/gst-council-announces-major-rate-rationalization-and-trade-facilitation-measures.pdf) | 2026-10-19 | From 22-09-2025 |
| S7 | CGST Act 2017, IGST Act 2017 (s.9, 31, 34, 36; IGST s.10–13) | https://cbic-gst.gov.in/ | Not yet re-checked | Verify |
| S8 | CERT-In Directions 28-04-2022 (6-hour reporting) | https://www.cert-in.org.in/ | Not yet re-checked | Verify |
| S9 | DPDP Act 2023 and DPDP Rules | https://www.meity.gov.in/ | Not yet re-checked | Verify |
| S10 | E-invoice portal master codes (UQC list; state codes with PIN ranges) | https://einvoice1.gst.gov.in/Others/MasterCodes | 2026-10-19: fetched and transcribed into `packages/contracts/src/india.ts` | Current at check date |
| S11 | GSTIN layout, Luhn mod-36 check character and PAN holder types (reference implementation, not an official specification) | python-stdnum `stdnum/in_/gstin.py`, `luhn.py`, `pan.py` (https://github.com/arthurdejong/python-stdnum) | 2026-10-19; reference GSTIN 27AAPFU0939F1ZV used as a test vector | Verify against GSTN if a specification is published |

## 8. Unresolved legal-review items
| ID | Question |
|---|---|
| C-01 | Place-of-supply defaults for bill-to-ship-to and for each supported service category |
| C-02 | Which reverse-charge categories (s.9(3)/9(4)) the pilot customers need configured |
| C-03 | Acceptability of per-line tax rounding vs rate-wise aggregate computation |
| C-04 | Cess applicability after compensation-cess changes; items in pilot catalogues |
| C-05 | Treatment of free supplies, schemes and post-supply discounts (s.15(3)) |
| C-06 | Tax on advances for services; receipt-voucher tax treatment |
| C-07 | E-invoice/e-way-bill API access route (direct vs GSP), costs, contracts |
| C-08 | Credit-note time limit and ITC reversal communication to customers |
| C-09 | Composition dealer declaration text and restrictions (e.g. inter-state supply) |
| C-10 | DPDP obligations as processor vs fiduciary; retention; breach notification |
| C-11 | Whether e-invoice applicability should block (not just warn) issuing B2B tax invoices without IRN |

## 11. Phase 7 implementation notes (2026-10-20)
- **Document kind (GST-14):** an invoice is a bill of supply when the seller's registration is composition, or when no line is taxable (exempt, nil-rated or non-GST). Otherwise it is a tax invoice, even with some exempt lines on it. Tax invoices and bills of supply number from their own series per GSTIN. The preview now uses the same rule (Phase 6 used composition only).
- **Issue-time checks (GST-02/03/04):**
  - A registered customer's address must be on the invoice.
  - An unregistered customer with a taxable value of ₹50,000 or more needs the billing and delivery addresses with their states (Rule 46).
  - HSN/SAC must meet the turnover band's minimum on tax invoices. For the band up to ₹5 crore it is enforced on B2B invoices only (the B2C exemption in GST-04). Above ₹5 crore it is enforced on every tax invoice, exempt lines included. Verify with a CA.
- **Place of supply (GST-10, C-01 still open):**
  - The default is the state of the shipping address, else the billing address, else the seller's own state.
  - A state chosen by the user that differs from the default is an override. The document shows it as chosen, and the confirm or issue audit entry records it.
  - The buyer's GSTIN is the one linked to the billing address, else the one in the place-of-supply state.
- **E-invoice (GST-05/06, C-11):** nothing is submitted to the IRP. A B2B tax invoice of a business whose band makes e-invoicing applicable gets the sub-state "Not submitted". The screen shows a "Not submitted to IRP" badge. The PDF footer says it is not an e-invoice and no IRN was obtained. Issuing is not blocked (C-11 still open).
- **Copies (Rule 48, Rule 55):** invoices print Original, Duplicate and Triplicate copies for goods, and Original and Duplicate for services only. Delivery challans print three copies (consignee, transporter, consignor) with the reason for transport ("Supply"), the vehicle and the e-way bill line. The e-way bill line reads "Not generated by this system" unless a number was recorded (GST-20 still not generated).
- **Quotations and proforma invoices** print "This is not a tax invoice" and label tax as an estimate.
- **Cancellation:** an issued invoice keeps its number and is marked cancelled; its journal is reversed (FR-ADJ-04). Credit notes (s.34) arrive in Phase 9. Until then, a post-supply correction other than cancellation is not possible.
- **Not covered yet:** credit-note time limits (C-08), tax on advances (C-06), free supplies (C-05, still blocked), supplies between two GSTINs of one PAN through these documents. The last needs a tax invoice to oneself under the other GSTIN, which works only if the business adds itself as a customer: verify the accounting with a CA before use.

## 10. Phase 6 implementation notes (2026-10-20)
- **Calculation (financial-policy §2–4):** per-line tax rounding (C-03 still open), largest-remainder allocation of document discounts, half-up round-off shown separately. Rates come only from the tenant's verified schedules on the document date; with no rate, the preview refuses rather than guessing (GST-11).
- **CGST/SGST/UTGST/IGST (GST-09):** intra-state when the seller's GSTIN state equals the place of supply; UTGST instead of SGST in Union Territories without a legislature (04, 25, 26, 31, 35, 38; Verify). The place of supply is always an explicit input (GST-10, C-01 open).
- **Composition (GST-14, C-09):** a composition registration gets a bill of supply with no tax; inter-state supply by a composition taxpayer raises a warning, not a block (Verify).
- **Reverse charge (GST-13):** tax on reverse-charge lines is calculated and shown but not added to the total; the preview warns that the document must say so.
- **Free supplies (C-05):** zero-price lines are refused by default.
- **HSN digits (GST-04):** the preview warns when an item's code is shorter than the turnover band's minimum. Blocking at issue arrives with invoices (Phase 7).
- **Stock transfers and GSTINs:** each GSTIN is a distinct person. Moving goods between warehouses under different GSTINs is a supply that needs a tax invoice, so it is refused as a stock transfer (Phase 5 allowed it; fixed in Phase 6). Transfers under one GSTIN print a "Stock transfer note" that states it is not a tax invoice, delivery challan or e-way bill (GST-16 and GST-20 are not covered).

## 9. Phase 4 implementation notes (2026-10-20)
- **GSTIN checks:** 15 characters, the normal-taxpayer layout, a state code from S10, an embedded PAN with a valid holder type, and the check character (S11). A unit test confirms that every single-character typo in a valid GSTIN is detected.
  - A GSTIN registered to a business entity must contain that entity's PAN.
  - A party's GSTINs must match the party's PAN when one is given.
  - The registration address must be in the GSTIN's state.
  - Passing these checks does not show that a GSTIN is active. No GSTN lookup exists; that would be an external service.
- **Not yet accepted:** GSTIN-like identifiers for UIN holders, TDS/TCS deductors, non-resident taxable persons and OIDAR suppliers. State codes 97 (Other Territory) and 99 (Centre Jurisdiction) are also rejected: they were not in S10.
- **State code 25 (Daman and Diu):** still listed separately on the portal. It is kept so historic records validate, but it isn't offered for new addresses; 26 covers the merged union territory.
- **Turnover band (FR-CO-06):** declared by the user, never computed. It drives the minimum HSN digits shown (4 or 6; GST-04) and the e-invoice notices (GST-06/07). The notice states plainly that BizMgmt doesn't generate e-invoices and that its PDFs are not e-invoices.
- **Document series (GST-01):**
  - Numbers are capped at 16 characters, using letters, digits, "/" and "-".
  - `{FY}` renders as YY-YY of the April–March financial year.
  - Two series of the same type and scope may not have prefixes that could produce the same number.
  - A series' format locks once numbers are issued.
  - Composition registrations can't have tax-invoice series; they use bills of supply (Verify: C-09).
  - The financial year is fixed to April–March. FR-CO-01's configurable FY start is limited to April in this version, because GST numbering follows the April–March year.
- **Rates (GST-11):** no rates are shipped, including in the demo seed.
  - Every rate row needs a source reference and records who added it and when.
  - Rate periods can't overlap.
  - Non-taxable classes can't have rates.
  - Reverse charge is an explicit per-class flag (GST-13).
