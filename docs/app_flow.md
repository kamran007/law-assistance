# App Flow Document
## Project: BD-LawAssist — Web & Mobile Client Flows (MVP)

| Attribute | Details |
| :--- | :--- |
| **Source Document** | `bd_lawassist_mvp_software_requirements_specification.md` (SRS) |
| **Clients Covered** | Web Application (desktop workspace), Mobile Application (iOS & Android) |
| **Roles Covered** | `CITIZEN`, `LAWYER`, `JUDGE`, `ADMIN` (minimal) |
| **Purpose** | Defines every screen, how the user moves between them, what API call each step makes, and how each role's experience differs. |

> **Notation.** `[Screen]` = a screen or panel · `(Action)` = user action · `{System}` = backend or client processing · `<Decision?>` = branch.
> Items marked **⚠ Assumption** are not stated in the SRS. They are proposed here so the flow is complete, and need product sign-off. Section 16 lists all of them.

---

## 1. Flow Overview

```text
                         +----------------------+
                         |   App Launch / URL   |
                         +----------+-----------+
                                    |
                         <Has valid JWT session?>
                           |                  |
                          No                 Yes
                           |                  |
                           v                  |
               [Onboarding & Auth] (§3)       |
                           |                  |
                           +--------+---------+
                                    v
                       [Home: Legal Assistant] (§4)
                                    |
     +--------------+---------------+---------------+----------------+
     |              |               |               |                |
     v              v               v               v                v
[Ask by Text]  [Ask by Voice]  [Scan Document]  [Case Files]   [Law Library]
   (§5)          (§6)             (§9)            (§8)            (§7)
     |              |               |               |
     +------+-------+               |      +--------+---------+
            v                       |      |                  |
  [Streaming Answer +               |      v                  v
   Citation Chips]                  |  [Case Workspace]   [Live Dictation
            |                       |      |               Editor] (§10)
            v                       |      |                  |
  [Split-Screen Law Verifier] <-----+------+                  v
            (§7)                                         [Export DOCX/PDF] (§12)
```

---

## 2. Navigation Structure

### 2.1 Web Application (Desktop Workspace)

Persistent **left sidebar** + **main canvas** + collapsible **right verifier panel**.

| Sidebar Item | Screen | Visible To |
| :--- | :--- | :--- |
| Assistant | `[Assistant Chat]`: general conversations not linked to any case | All roles |
| Case Files | `[Case File List]` → `[Case Workspace]`. For Lawyers and Judges, each case has its own conversation (§5.2). | All roles (Citizen: scans only, with no case conversation and no drafts) |
| Scan / Upload | `[Upload Document]` modal | All roles |
| Law Library | `[Statute Browser]` with a **Statutes / Case Law** switch (§7.2, §7.3) | All roles |
| GD Template | `[GD Voice Form]` | `CITIZEN` |
| Admin | `[Admin Console]` | `ADMIN` only — ⚠ Assumption |
| Profile & Settings | `[Settings]` | All roles |

The **right panel** (`[Law Verifier]`) opens whenever a citation is clicked, anywhere in the app, so verbatim law text sits beside the AI answer, the FIR analysis or the draft.

### 2.2 Mobile Application

**Bottom tab bar** with a center action button.

```text
+---------+-----------+-------------+-----------+---------+
|  Home   |   Cases   |  [ SCAN ]   |  Library  | Profile |
| (Chat)  |           | center FAB  |           |         |
+---------+-----------+-------------+-----------+---------+
         A floating push-to-talk mic button sits on the Home (Chat) tab.
```

- The law verifier opens as a **bottom sheet** (drag up to read the full screen) instead of a side panel. The same sheet shows a judgment when a judgment citation is tapped.
- The Library tab has the same **Statutes / Case Law** switch as the web.
- Live dictation opens full screen from inside a Case File (Lawyer/Judge).

---

## 3. Onboarding & Authentication Flow

**API (as built, BE-03/04):** `POST /api/v1/auth/otp/request` → `POST /api/v1/auth/otp/verify` (alias `/auth/login`) returns the tokens and `is_new_user`. The first verified code creates the account as `CITIZEN`; Profile Setup then calls `PATCH /me` (name) and, for Lawyers/Judges, `POST /me/credential` (status `PENDING` until an admin approves).

```text
[Splash] (mobile only)
    |
    v
[Language Picker: বাংলা / English]  -> sets preferred_language (BN | EN)
    |
    v
[Welcome / Login]
    | (Enter phone number or email)
    v
{Send OTP}  ⚠ Assumption: the SRS says "verified" contact_identifier; OTP is the proposed verification method
    |
    v
[OTP Entry] --(wrong / expired)--> show error, allow resend after 60 s
    |
    v
<Existing user?>
   |            |
  Yes           No
   |            |
   |            v
   |      [Profile Setup]
   |        - Full name
   |        - Role: Citizen | Lawyer | Judge
   |            |
   |       <Role selected?>
   |        |        |          |
   |     Citizen   Lawyer      Judge
   |        |        |          |
   |        |        v          v
   |        |  [Bar Council   [Judicial ID
   |        |   Enrollment     Entry]
   |        |   No. Entry]      |
   |        |        +----+-----+
   |        |             v
   |        |   {Store verification_credential;
   |        |    account status = PENDING_VERIFICATION}  ⚠ Assumption
   |        |             |
   |        +------+------+
   |               v
   +-------> {POST /auth/login -> JWT (role claim)}
                   |
                   v
           [Home: Legal Assistant]
```

**Rules**
- A Lawyer or Judge whose credential is still `PENDING_VERIFICATION` uses Citizen-level features, with a banner: *"Your Bar Council / Judicial ID is being verified. Professional tools will unlock once approved."* ⚠ Assumption
- The role cannot be changed by the user after setup. Changing it requires re-verification through an admin. ⚠ Assumption
- JWT expiry triggers a silent refresh. If refresh fails, the user returns to `[Welcome / Login]` and any unsaved draft is kept locally (see §13).

---

## 4. Home: Legal Assistant Screen

The default landing screen for every role.

| Element | Behavior |
| :--- | :--- |
| Role badge | Shows `Citizen` / `Advocate` / `Judicial Officer`. It tells the user which answer style they will get. |
| Language toggle | BN / EN output for this session. Defaults to `preferred_language`. |
| Text input box | Type a legal question (§5). |
| Mic button | Press and hold to ask by voice (§6). |
| Suggested prompts | Role-specific starters, e.g. Citizen: *"পুলিশ এজাহার নিতে না চাইলে কী করব?"*; Lawyer: *"Limitation period for a suit for specific performance"*; Judge: *"Is Section 406 Penal Code compoundable?"* |
| Conversation history | Previous general (non-case) threads, plus a **+ New conversation** button. The user can reopen, rename or delete a thread. Case conversations are not listed here. |

> **Citizens:** all their chats live here, as a normal conversation history.
> **Lawyers & Judges:** the Home assistant is for general legal questions. Questions about a specific case go in that Case File's own conversation (§5.2). The Home assistant has no case selector.

---

## 5. Flow: Text Legal Q&A (Citation-Backed RAG)

**API:** `POST /api/v1/assistant/query` (SSE stream) · `GET /api/v1/statutes/{act_id}/sections/{sec}` for verification.

```text
[Assistant Chat]
    | (Type question, press Send)
    v
{POST /assistant/query  { conversation_id, query, language }}
 (the conversation_id decides whether this is a general or a case conversation)
    |
    v
{Backend: role-aware prompt router -> hybrid vector + keyword retrieval
 -> uses CURRENT section versions (or the offense-date version, §5.2)}
    |
    v
[Streaming Answer]  -- first token in under 1.5 s
    - Text appears token by token
    - Citation chips render inline: [Section 497, Code of Criminal Procedure, 1898]
    - Judgment chips (different style, with an AD/HCD badge):
      [Md. Humayun Kabir Vs. The State, 20 SCOB [2025] AD, para 74]
    |
    v
<Verified provision found?>
    |                          |
   Yes                         No
    |                          |
    v                          v
[Answer + citation chips]   [Fixed message: "No verified statutory provision
    |                         was found for this question."]
    |                         + suggestions: rephrase / search Law Library
    | (Tap a citation chip)
    v
[Law Verifier panel / bottom sheet]  (§7)
    or, for a judgment chip,
[Judgment Viewer, scrolled to the cited paragraph]  (§7.3)
```

Judgments only add to a statute-backed answer. If no statute provision is found, the "No verified statutory provision" message is shown even when related judgments exist.

### 5.1 How the answer differs by role

| Role | Answer Style Shown |
| :--- | :--- |
| `CITIZEN` | Plain, empathetic Bangla/English. Rights and practical next steps. No jargon. |
| `LAWYER` | Analytical and strategic. Defense angles, prosecution burden, cross-references (e.g. linked Evidence Act sections), limitation checks. |
| `JUDGE` | Neutral bench-memo format. Statutory compliance, jurisdiction, admissibility, sentencing limits, compoundability. |

All roles may see judgment citations. Citizens get a one-line plain explanation of what the court held. Lawyers and Judges see the division and the cited paragraph number, and a note when the judgment was decided on an earlier version of the section.

### 5.2 Case Conversations (Lawyer & Judge): one case, one conversation

Each Lawyer or Judge Case File has **exactly one conversation**. Citizens don't get case conversations. They use the conversation history on Home (§4). A case conversation is completely separate from general chats and from every other case.

| Rule | Behavior |
| :--- | :--- |
| Created automatically | A case's conversation is created along with the Case File. The user never picks a case from a selector. |
| Isolated context | The AI sees only this case's messages, documents, scan results, drafts and offense date. Nothing from another case or from a general chat enters the context, and nothing from this case leaks out. |
| Persistent | Opening the case on web or mobile reopens the same thread with its full history (§13). |
| No moving or merging | A message cannot be moved between cases, and a general chat cannot be turned into a case chat. ⚠ Assumption |
| Deleted with the case | Deleting a Case File deletes its conversation. |
| Roles | `LAWYER` and `JUDGE` only. |

```text
[Case Workspace] -> Conversation tab
    |
    v
{Load this case's conversation history}
    | (Ask by text or voice)
    v
{POST /assistant/query { conversation_id = this case's conversation, ... }}
{Context = this case's history + documents + drafts ONLY}
    |
    v
<Case has alleged_offense_date?>
    |                     |
   Yes                    No
    |                     |
    v                     v
{Retrieve the section    {Retrieve CURRENT versions}
 version valid on
 offense date}
    |
    v
[Banner above answer: "Law shown as it stood on 14-03-2024 (offense date).
 Current wording differs — View current version"]
```

### 5.3 Cross-lingual behavior
A user can ask in Bangla about an English-language statute (e.g. Evidence Act, 1872). The answer is in the user's language. The verifier always shows the **verbatim original** text, in its original language.

---

## 6. Flow: Voice Query (Push-to-Talk)

**API:** `POST /api/v1/voice/transcribe-query` → then §5 flow.

```text
[Assistant Chat]
    | (Press and hold mic)
    v
<Microphone permission granted?>
    |                       |
   Yes                      No
    |                       v
    |              [Permission prompt / "Enable microphone in Settings"]
    v
[Recording overlay: waveform + timer + "Release to send, slide to cancel"]
    |
    +--(Slide away)--> cancel, discard audio
    |
    | (Release)
    v
<Recording shorter than 1 s or silent?>  --Yes--> toast: "Didn't catch that. Hold the mic and speak."
    |
    No
    v
{POST /voice/transcribe-query  (audio)}
{Bilingual ASR -> Legal Glossary post-processor (fixes এজাহার, CrPC, 561A ...)}
    |
    v
[Transcript appears in the input box, editable]
    |
    +--(Auto-sends after 2 s unless the user taps to edit)  ⚠ Assumption
    v
→ Continues as Text Q&A (§5) with the transcribed text
```

---

## 7. Flow: Law Verifier & Statute Browser

**API:** `GET /api/v1/statutes/{act_id}/sections/{sec}`

### 7.1 Opening the verifier
Opened from: a citation chip in an answer · a section row in an FIR analysis · a citation inside a draft · a search in Law Library.

```text
[Law Verifier Panel]
 +-------------------------------------------------------------+
 | Penal Code, 1860 (Act No. XLV of 1860)      Status: ACTIVE  |
 | Chapter XVII — Of Offences Against Property                 |
 | Section 420 — Cheating and dishonestly inducing delivery... |
 |-------------------------------------------------------------|
 | Verbatim text (with provisos & explanations)                |
 |-------------------------------------------------------------|
 | Amendment footnotes (substituted / inserted / omitted)      |
 |-------------------------------------------------------------|
 | Version: v3 (current) · Valid from 2023-07-01               |
 | [Version history ▾]   [Copy citation]   [Open full Act]     |
 |-------------------------------------------------------------|
 | CrPC Schedule II: Cognizable · Non-bailable ·               |
 | Non-compoundable · Max: 7 yrs + fine · Magistrate 1st Class |
 |-------------------------------------------------------------|
 | Judgments on this section (3)                    [See all]  |
 |  AD  Md. Humayun Kabir Vs. The State · 20 SCOB [2025] AD    |
 |  HCD … · ⚠ Decided before this section was amended          |
 +-------------------------------------------------------------+
```

**API:** `GET /api/v1/statutes/{act_id}/sections/{sec}/judgments` for the judgments block. It is hidden when no judgment is linked.

- **Version history** lists every version with `valid_from` / `valid_to` dates. Tapping one shows the old text with a diff highlight against the current version. Lawyer & Judge only (FR-A4). Citizens see only the current version.
- **Repealed** statutes show a red `REPEALED` badge, and AI answers never cite them as current law.
- The Schedule II strip appears only for sections that have a row in `CrPC_Schedule_Metadata`.

### 7.2 Statute Browser (Law Library)

```text
[Statute Browser]
    | (Search by title, act number, year, or keyword — BN or EN)
    v
[Act List]  (filter: Active / Repealed, year)
    |
    v
[Act Detail: Parts / Chapters tree]
    |
    v
[Section] -> opens the same Law Verifier view (§7.1)
```

### 7.3 Case Law (Supreme Court judgments, Module D)

**API:** `GET /api/v1/judgments?q=&division=&year=&act_id=&sec=` · `GET /api/v1/judgments/{judgment_id}`

```text
[Law Library] -> (Case Law)
    | (Search by keyword, party, judge, or Act + section — BN or EN)
    v
[Judgment List]  (filter: Appellate Division / High Court Division, year)
    - each row: parties · citation · division badge · authoring judge · key words
    |
    v
[Judgment Viewer]
 +-------------------------------------------------------------+
 | Md. Humayun Kabir Vs. The State          Appellate Division |
 | 20 SCOB [2025] AD · Criminal Appeal No. … · Decided …       |
 | Judge: Syed Md. Ziaul Karim, J                              |
 |-------------------------------------------------------------|
 | Key words · Summary (as published in SCOB)                  |
 | Key ratio: para 74   [Jump to para]                         |
 |-------------------------------------------------------------|
 | Full text with numbered paragraphs                          |
 |-------------------------------------------------------------|
 | Sections referred to: Penal Code s.302 → opens verifier     |
 | [Copy citation]   [Open original PDF]                       |
 +-------------------------------------------------------------+
```

- Opened from: a judgment chip in an answer · the judgments block in the verifier (§7.1) · the Case Law search.
- Sections referred to in the judgment link to the Law Verifier. References that couldn't be matched to a stored section are shown as plain text, not as links.
- "Open original PDF" opens the court's PDF from storage, so the user can check the source.
- Judgments whose text couldn't be extracted yet (`NEEDS_REVIEW`) are not listed.

---

## 8. Flow: Case File Lifecycle

**API:** `POST /api/v1/cases` (create) · `GET /api/v1/cases` (list / sync)

### 8.1 Create & open

```text
[Case File List]
    | (+ New Case File)
    v
[Create Case File form]
    - Case number (e.g. "G.R. Case No. 412/2026")      optional for Citizen
    - Court or Thana name
    - Alleged offense date (optional; enables historical law lookup)
    | (Save)
    v
{POST /cases}
    |
    v
[Case Workspace]
```

### 8.2 Case Workspace layout

| Tab | Contents | Roles |
| :--- | :--- | :--- |
| **Overview** | Case number, court/thana, offense date, document count, last synced time | All |
| **Documents** | Scanned/uploaded artifacts (`FIR_SCAN`, `CHARGE_SHEET`, `COURT_ORDER_NOTE`) with processing status | All |
| **Drafts** | Voice-dictated or typed drafts (`VOICE_DICTATION_DRAFT`) | `LAWYER`, `JUDGE` |
| **Conversation** | This case's own chat thread, isolated from all other cases and general chats (§5.2) | `LAWYER`, `JUDGE` |

Actions on the workspace: Edit details · Scan / Upload document (§9) · New draft (§10) · Delete case file (with confirmation; deletes all artifacts and stored files). ⚠ Assumption: the SRS defines no delete endpoint.

### 8.3 Privacy rule (every case screen)
Case files and artifacts are visible only to `owner_user_id`. The app offers no sharing or collaboration in the MVP, so no screen shows share options.

---

## 9. Flow: FIR & Legal Document Scan

**API:** `POST /api/v1/cases/{id}/documents/scan` (starts async OCR + Schedule II analysis).

### 9.1 Capture (Mobile)

```text
(Tap center SCAN button)
    |
    v
<Camera permission granted?> --No--> [Permission prompt / Settings link]
    |
   Yes
    v
[Camera Viewfinder]  - live edge detection outline
    | (Capture page)
    v
[Page Preview]  - auto-crop, deskew, contrast enhancement applied
    |   (Retake) / (Adjust corners) / (Add another page) / (Done)
    v
[Page Order screen]  - reorder / delete pages (multi-page FIRs)
    |
    v
[Document Details]
    - Document type: FIR (এজাহার) | Charge Sheet (অভিযোগপত্র) | Seizure List (জব্দ তালিকা) | Court Order
    - Attach to: existing Case File ▾ | + Create new Case File
    | (Upload)
    v
→ §9.3 Processing
```

### 9.2 Upload (Web)

```text
(Click "Scan / Upload" or drag a file onto the Case Workspace)
    |
    v
[Upload modal]  - accepts PDF, DOCX, JPG/PNG
    |
<File valid? (type, size)> --No--> inline error: "Unsupported file" / "File too large (max N MB)"
    |
   Yes
    v
[Document Details]  (same fields as mobile)
    v
→ §9.3 Processing
```

### 9.3 Processing (async)

```text
{POST /cases/{id}/documents/scan} -> returns artifact_id, status = PROCESSING
    |
    v
[Document card in Documents tab shows a progress stepper]
    1. Uploaded
    2. Reading text (Bilingual OCR + Bijoy -> Unicode)
    3. Extracting details (Thana, dates, parties, sections)
    4. Checking CrPC Schedule II
    5. Preparing analysis (role-specific)
    |
<Result>
    |-- Success (target: under 6 s for one page) --> [Scan Result] (§9.4)
    |                                                 + push notification if the app is in the background ⚠ Assumption
    |-- Low OCR confidence --> [Scan Result] with a "Some text may be unclear — please review" banner
    |-- Failure --> card shows "Couldn't read this document" + (Retry) / (Rescan)
```

> **Gap:** The SRS defines no endpoint for checking scan status. Proposed: `GET /api/v1/cases/{id}/artifacts/{art_id}` for polling, or a server push event.

### 9.4 Scan Result screen

Every role sees the same top section. The analysis block below it differs by role.

```text
[Scan Result]
 +---------------------------------------------------------------+
 | FIR DETAILS                                    [Edit fields]  |
 | Thana: Motijheel · District: Dhaka · FIR No.: 12 · G.R.: 412  |
 | Occurrence: 02-10-2026 22:30   Reported: 05-10-2026 11:00     |
 | ⚠ Delay in filing: 2 days 12 hours                            |
 | Informant: ...   Accused: ...   Witnesses: ...                |
 |---------------------------------------------------------------|
 | CITED SECTIONS  (from verified CrPC Schedule II table)        |
 | Section | Cognizable | Bailable | Compoundable | Max | Court  |
 | 420 PC  |    Yes     |    No    |     Yes*     | 7y  | Mag 1st|
 | 406 PC  |    Yes     |    No    |     Yes*     | 3y  | Mag 1st|
 |  -> tap a row to open the Law Verifier                        |
 |---------------------------------------------------------------|
 | ROLE-SPECIFIC ANALYSIS (below)                                |
 |---------------------------------------------------------------|
 | [View original scan]  [Ask about this document]  [Export]     |
 +---------------------------------------------------------------+
```

- **Edit fields:** the user can correct OCR mistakes (e.g. a misread section number). Saving re-runs the Schedule II lookup and the analysis. ⚠ Assumption
- **Section not in the Schedule II table:** the row shows "Not in verified schedule — check the statute text". The app never shows an AI-guessed bail or cognizance status (FR-B3).
- **Bangla numerals** (`ধারা ৪২০/৪০৬`) and combined citations (`302/34`) are split into separate rows.

| Role | Analysis Block |
| :--- | :--- |
| `CITIZEN` | Plain-language explanation of each section, what "bailable / non-bailable" means for them, and practical next steps. |
| `LAWYER` | **Ingredient & Loophole Audit:** each statutory ingredient marked *Alleged / Not alleged / Unclear*; unexplained-delay flag; suggested grounds for bail or quashment, each with citations. |
| `JUDGE` | **Charge-Framing Matrix:** prosecution allegations mapped against required ingredients, in neutral language, with no advocacy. |

**"Ask about this document"**
- **Lawyer / Judge:** opens **this case's Conversation tab** with the document referenced in the input box.
- **Citizen:** starts a **new conversation** in their Home conversation history, with this scan's result attached as context. ⚠ Assumption

---

## 10. Flow: Live Case File Dictation (Lawyer & Judge)

**API:** `WSS /api/v1/voice/stream-dictation` · drafts are saved as `Case_Artifacts` (`VOICE_DICTATION_DRAFT`).

```text
[Case Workspace] -> Drafts tab
    | (+ New Draft)
    v
[Choose Template]
    Lawyer: Bail Petition · Legal Notice · Argument Notes · Witness Summary · Plaint · Blank
    Judge:  Bench Notes · Draft Order Sheet · Issue-Framing List · Judgment Summary · Blank
    v
[Draft Editor]  (rich text; template headings pre-filled with case number and court)
    | (Tap mic to start dictation)
    v
<Microphone permission?> --No--> permission prompt
    |
   Yes
    v
{Open WebSocket; stream audio chunks}
    |
    v
[Editor in dictation mode]
    - Red "Listening" indicator + live waveform
    - Interim words shown in grey at the cursor (target: under 800 ms)
    - Finalized words turn black after Legal Glossary correction
      (e.g. "e jahar" -> এজাহার, "five sixty one a" -> 561A)
    - Spoken commands: "new paragraph", "full stop" / "দাঁড়ি"  ⚠ Assumption
    |
    | (Tap mic again to pause)  /  (Tap Done)
    v
{Close stream; autosave draft (editable_document_html + raw audio stored)}
    |
    v
[Draft Editor - normal editing mode]
    - Type or edit freely; citations typed or dictated become clickable chips
    - (Export) -> §12
```

**Connection problems while dictating**
- WebSocket drops: the client keeps recording to a local buffer, shows "Reconnecting…", and sends the buffered audio once reconnected.
- Reconnect fails after 30 s: dictation stops, the text already received is kept, and the buffered audio is saved for re-transcription. ⚠ Assumption

**Autosave:** every few seconds while editing and at the end of dictation. A "Saved · Synced" indicator shows in the editor header.

---

## 11. Flow: Citizen GD Template Voice-Fill

The voice-guided version of the dictation feature for citizens (SRS §3: *voice-guided filling of basic General Diary (GD) templates*).

```text
[GD Template list]  (e.g. Lost document/property, Threat, Missing person)  ⚠ Assumption: template set
    v
[Guided Form]  one field at a time
    - App reads/shows the prompt: "আপনার নাম বলুন" / "When did this happen?"
    - (Hold mic and answer)  ->  {POST /voice/transcribe-query}
    - Answer fills the field; user can edit by typing
    - (Next field)
    v
[Review GD]  all fields + generated GD text
    v
(Save to Case File)  /  (Export PDF) §12  /  (Share)
```

> The GD is a draft to print or show at the police station. The app does not submit it to the police.

---

## 12. Flow: Export

**API:** `POST /api/v1/cases/{id}/artifacts/{art_id}/export`

```text
[Draft Editor] or [Scan Result] or [Review GD]
    | (Export)
    v
[Export sheet]
    - Format: DOCX | PDF
    - Include: citations as footnotes (on/off)  ⚠ Assumption
    v
{POST .../export}  -> generated file
    v
Web: browser download
Mobile: OS share sheet (save to Files, WhatsApp, email, print)
```

---

## 13. Cross-Device Sync Flow (FR-C4)

```text
[Mobile: scan FIR in court]            [Web: open the same Case File in chamber]
        |                                          ^
        v                                          |
{Artifact saved to backend} ---------------> {GET /cases on open / focus}
                                                   |
                                                   v
                                     [FIR analysis visible on web]
```

- Case lists and artifacts refresh when the app opens, when a tab or window regains focus, and on pull-to-refresh (mobile).
- **Editing conflicts:** if the same draft was edited on two devices, the later save wins and the earlier version is kept as a recoverable copy. ⚠ Assumption: the SRS doesn't define conflict handling.
- **Offline (mobile):** captured scans and unsaved drafts queue locally and upload when the device reconnects. A "Waiting for connection" badge marks them.

---

## 14. Profile & Settings

| Setting | Notes |
| :--- | :--- |
| Full name, contact | Changing the contact requires a new OTP. |
| Role & credential | Read-only. Shows verification status (Pending / Verified). |
| Preferred language | BN / EN. Sets the default assistant output language. |
| Privacy notice | States that documents are encrypted, private to the user and never used for training (NFR 3). |
| Logout | Clears the local session and cached case data on this device. |

---

## 15. Background & Admin Flows (No end-user screens)

### 15.1 Statutory sync (Module A)
Users never trigger this flow, but it changes what they see:

```text
{Scheduled crawler -> parse -> SHA-256 per section}
    |
<Section changed?> --No--> skip
    |
   Yes
    v
{Archive old version (valid_to = today) -> insert new version (is_current = true)
 -> generate embedding}
    |
    v
User-visible effects:
  - Law Verifier shows the new version and adds the old one to Version history
  - A Case File whose cited sections changed after its offense date shows a note:
    "Section 420 was amended on DD-MM-YYYY. Your case uses the version valid on the offense date."  ⚠ Assumption
```

### 15.1a Judgment sync (Module D)

```text
{Weekly crawler -> SCOB index -> AD & HCD lists per issue -> judgment PDFs}
    |
<New or changed PDF?> --No--> skip
    |
   Yes
    v
{Extract text & metadata -> link to statute sections -> embed}
    |
    v
User-visible effects:
  - New judgments appear in Case Law search and in the verifier's "Judgments on this section" block
  - Judgments with missing metadata wait in the admin review queue (§15.2) and are hidden until fixed
```

### 15.2 Admin Console (minimal) ⚠ Assumption
The SRS defines the `ADMIN` role but no admin screens. Proposed MVP scope:
- **Credential verification queue:** approve or reject Lawyer/Judge Bar Council or Judicial IDs.
- **Sync dashboard:** last sync time per statute, failed crawls, number of new amendment versions. SCOB runs: issues found, judgments new/changed/failed.
- **Judgment review queue:** judgments whose decision date, case number or text couldn't be extracted; the admin fills in the missing fields (logged).
- **Schedule II table editor:** correct rows in `CrPC_Schedule_Metadata` (every change logged).

---

## 16. Role Access Summary

| Screen / Capability | Citizen | Lawyer | Judge | Admin |
| :--- | :---: | :---: | :---: | :---: |
| General chats with conversation history (text & voice) | ✅ | ✅ | ✅ | — |
| Per-case conversation (one per Case File) | — | ✅ | ✅ | — |
| Law Verifier — current version | ✅ | ✅ | ✅ | ✅ |
| Law Verifier — version history / point-in-time | — | ✅ | ✅ | ✅ |
| Case Law search & Judgment Viewer | ✅ | ✅ | ✅ | ✅ |
| Judgment citations in answers | ✅ (plain explanation) | ✅ (division + paragraph) | ✅ (division + paragraph) | — |
| Judgment review queue | — | — | — | ✅ |
| Case Files | ✅ (scans only) | ✅ | ✅ | — |
| FIR / document scan | ✅ (simple table) | ✅ (ingredient audit) | ✅ (charge matrix) | — |
| Live dictation drafts | — | ✅ | ✅ | — |
| GD voice template | ✅ | — | — | — |
| Export DOCX / PDF | ✅ | ✅ | ✅ | — |
| Admin Console | — | — | — | ✅ |

---

## 17. Global Error & Empty States

| Situation | What the User Sees |
| :--- | :--- |
| No internet | Top banner "You're offline". Chat input disabled. Scans and drafts queue locally (§13). |
| Assistant stream interrupted | Partial answer kept, with "Answer interrupted — Retry". |
| No verified provision | Fixed message (NFR 1). The assistant never answers without a citation. |
| Citation points to a missing section | Chip shows a "Not verified" state. The answer is flagged for review and logged. |
| No judgments for a search or section | "No reported Supreme Court judgment found in the Online Bulletin." The judgments block in the verifier is hidden. |
| Original judgment PDF can't be loaded | The extracted text stays readable; "Original PDF unavailable right now — Retry". |
| Scan unreadable | "Couldn't read this document" + tips (lighting, flat surface) + Rescan. |
| Microphone / camera denied | Explanation + button to open OS settings. |
| Session expired | Silent refresh. If it fails, go to login and keep local drafts. |
| Empty Case File list | Illustration + "Create your first case file" + "Scan an FIR" buttons. |
| Empty Drafts tab | "Dictate or type your first draft" + template shortcuts. |

---

## 18. Gaps Found in the SRS (Need Decisions)

| # | Gap | Proposal in This Document |
| :--- | :--- | :--- |
| 1 | No sign-up, OTP or credential-verification flow defined | OTP login + `PENDING_VERIFICATION` status + admin approval (§3, §15.2) |
| 2 | No endpoint to check async scan status | `GET /cases/{id}/artifacts/{art_id}` polling or server push (§9.3) |
| 3 | `artifact_type` enum has no Seizure List or GD type, but both are in scope | Add `SEIZURE_LIST` and `GD_DRAFT` |
| 4 | No chat-history entity. Citizens need a conversation history, and Lawyers/Judges need one conversation per case. | Add `Conversations` (`conversation_id`, `owner_user_id`, `case_file_id` nullable + **unique**: one per case for Lawyer/Judge, always null for Citizens) and `Messages`. `/assistant/query` takes `conversation_id`, and the backend builds context only from that conversation and its case. |
| 5 | Citizen access to Case Files is not stated, but the scan endpoint requires a case ID | Citizens get scan-only Case Files (§8.2) |
| 6 | No update, delete or list endpoints for artifacts and drafts | Add `GET/PUT/DELETE /cases/{id}/artifacts/{art_id}` and `DELETE /cases/{id}` |
| 7 | No dictation conflict or offline rules | Last-write-wins with a recoverable copy; offline queue (§13) |
| 8 | No admin screens despite the `ADMIN` role | Minimal Admin Console (§15.2) |
| 9 | No statute search / list endpoint for the Law Library | Add `GET /api/v1/statutes?q=` and `GET /api/v1/statutes/{act_id}` |
| 10 | SRS Module D lists judgments per search, but no endpoint for "judgments on this section" in the verifier | Add `GET /api/v1/statutes/{act_id}/sections/{sec}/judgments` (§7.1) |
