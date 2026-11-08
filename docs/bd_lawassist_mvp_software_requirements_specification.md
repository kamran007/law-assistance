# Software Requirements Specification (SRS)
## Project: BD-LawAssist — AI Legal Research, Document Analysis & Voice Dictation Platform (MVP)

| Document Attribute | Details |
| :--- | :--- |
| **Document Scope** | Minimum Viable Product (MVP) Software Requirements Specification |
| **Target Jurisdiction** | Laws of Bangladesh (`bdlaws.minlaw.gov.bd`) and reported judgments of the Supreme Court of Bangladesh (Supreme Court Online Bulletin, `supremecourt.gov.bd`) |
| **Architecture Pattern** | Decoupled API-First Backend (Serving Web & Mobile Clients) |
| **Target User Personas** | General Citizen, Lawyer (Advocate), Judge (Judicial Officer) |
| **Core Capabilities** | Automated Statutory Sync & Version Control, Supreme Court Judgment (Case-Law) Harvesting, Citation-Backed Legal RAG, Bilingual FIR/Document OCR, Real-Time Legal Voice-to-Text (STT) |

---

## 1. Executive Summary & System Purpose

**BD-LawAssist** is an AI-powered legal intelligence and case-file assistance platform built upon the official statutory corpus of the Ministry of Law, Justice and Parliamentary Affairs (`https://bdlaws.minlaw.gov.bd/laws-of-bangladesh.html`). Because laws in Bangladesh are periodically amended by new Acts and Ordinances, standard AI models suffer from outdated knowledge and legal hallucinations. BD-LawAssist eliminates this risk by pairing a **Temporal Statutory Version Control Engine** with a **Citation-Backed Retrieval-Augmented Generation (RAG)** workflow.

Statutes alone do not show how courts read them. The platform therefore also ingests the reported judgments of the **Appellate Division** and the **High Court Division** published in the **Supreme Court Online Bulletin (SCOB)** (`https://www.supremecourt.gov.bd/web/?page=bulletin.php&menu=10&lang=`). Each judgment is linked to the statutory sections it interprets, so the assistant can cite binding precedent next to the verbatim text of the law.

To support both courtroom/chamber workflows and on-the-go usage, the system is engineered around a **Decoupled Backend API** that powers both a **Web Application** and a **Mobile Application**. Users can query laws by text or voice, scan First Information Reports (FIRs) and legal documents via camera or file upload, and dictate case notes or legal drafts using a bilingual (Bangla + English) **Voice-to-Text (STT)** engine.

---

## 2. High-Level Decoupled System Architecture

The system separates presentation clients (Web and Mobile) from the core backend services and asynchronous background workers.

```text
+-----------------------------------+       +-----------------------------------+
|            WEB CLIENT             |       |           MOBILE CLIENT           |
|  - Desktop Workspace (Next.js)    |       |  - iOS & Android App (Flutter/RN) |
|  - Split-Screen Law Verifier      |       |  - Camera FIR & Doc Scanner       |
|  - Live Voice Dictation Editor    |       |  - Push-to-Talk Voice Assistant   |
+-----------------+-----------------+       +-----------------+-----------------+
                  |                                           |
                  +---------------------+---------------------+
                                        |
                     REST API / SSE Stream / WebSocket (WSS)
                                        |
                                        v
+-------------------------------------------------------------------------------+
|                        CORE BACKEND API GATEWAY LAYER                         |
|  - Authentication & Role-Based Access Control (Citizen | Lawyer | Judge)      |
|  - Case File & Workspace Synchronization Service                              |
|  - Real-Time Audio Streaming Controller (Voice-to-Text Dictation)             |
|  - Persona-Aware Legal RAG Orchestrator & Citation Verifier                   |
+-----------------+----------------------------+----------------------------+---+
                  |                            |                            |
        Async Task Queue             Vector & Relational          Encrypted Object
        (Background Jobs)                Queries                      Storage
                  |                            |                            |
                  v                            v                            v
+-------------------------+      +---------------------------+    +-------------+
|   ASYNC WORKER ENGINE   |      |   PRIMARY DATA STORE      |    | FILE VAULT  |
| - BDLaws Web Scraper    |----->| - Master Statutes Table   |    | - FIR Scans |
| - SHA-256 Law Diffing   |      | - Versioned Sections DB   |    | - PDFs/Docs |
| - SCOB Judgment Scraper |      | - CrPC Schedule II Matrix |    | - Raw Audio |
| - Bilingual OCR Engine  |      | - Judgments & Statute Refs|    |   Recordings|
| - Legal STT Refiner     |      | - Vector Embeddings Index |    | - SCOB PDFs |
+-------------------------+      +---------------------------+    +-------------+
            ^
            | Periodic Sync
            +--------------------------------+
            |                                |
+-------------------------+      +---------------------------+
|  bdlaws.minlaw.gov.bd   |      |  supremecourt.gov.bd      |
| (Official Govt Portal)  |      | (Supreme Court Online     |
|                         |      |  Bulletin - AD & HCD)     |
+-------------------------+      +---------------------------+
```

### 2.1 Architectural Layers Breakdown

| Architectural Layer | Target Platform / Technology | Primary Responsibilities |
| :--- | :--- | :--- |
| **Web Client** | Responsive Web Portal | Split-screen statutory research, side-by-side FIR vs. Law comparison, rich-text petition/order drafting with live voice dictation. |
| **Mobile Client** | Android & iOS Native/Cross-Platform | Smartphone camera scanner (auto-crop & contrast enhancement for FIRs), push-to-talk voice legal queries, synchronized access to Case Files. |
| **Core Backend Gateway** | REST + Server-Sent Events (SSE) + WebSockets | Central business logic, JWT role enforcement, token streaming for legal Q&A, and low-latency bi-directional audio streaming for voice typing. |
| **Async Worker Layer** | Background Task Queue | Executes heavy non-blocking workloads: crawling `bdlaws.minlaw.gov.bd`, harvesting Supreme Court Online Bulletin judgments, detecting law amendments, running multi-page OCR, and generating embeddings. |
| **Hybrid Database** | Relational + Vector Search Engine | Stores hierarchical acts/sections, temporal version history, deterministic CrPC Schedule II rules, Supreme Court judgments with their statute cross-references, user case files, and multilingual vector indexes. |
| **Object Storage Vault** | S3-Compatible Cloud Storage | Stores tenant-isolated, encrypted FIR images, uploaded PDFs, and recorded voice notes; also keeps the original public SCOB judgment PDFs (not tenant data) as the source of record. |

---

## 3. User Personas & Role-Based Capabilities

Every authenticated user is assigned one of three roles (`CITIZEN`, `LAWYER`, or `JUDGE`). The backend dynamically adapts the AI assistant's tone, analytical depth, and available tools based on this role.

| Feature Domain | General User (Citizen) | Lawyer (Advocate) | Judge (Judicial Officer) |
| :--- | :--- | :--- | :--- |
| **Assistant Tone** | Simple, empathetic Bangla or English; explains legal rights and practical steps without technical jargon. | Analytical, strategic, adversarial; highlights defense loopholes, prosecution burdens, and statutory cross-references. | Strictly neutral, objective, bench-memo style; focuses on statutory compliance, jurisdiction, and admissibility. |
| **Statutory Q&A** | Everyday legal questions (e.g., *"What to do if police refuse an FIR?"*, *"Punishment for check dishonor"*). | Deep statutory search, historical version lookups, limitation period checks, and linked Evidence Act rules. | Rapid verification of sentencing minimums/maximums, fine ceilings, and whether an offense is compoundable. |
| **Case-Law (Judgments)** | Plain-language summary of what the Supreme Court has said on an issue, always shown next to the statute; makes clear that outcomes depend on the facts of each case. | Searches AD/HCD judgments by statute section, keyword or party; shows the key ratio paragraph and flags whether it comes from the Appellate Division (binding on all courts, Art. 111) or the High Court Division. | Neutral list of binding Appellate Division and High Court Division precedents on the provision in question, with citation and ratio paragraph for the order sheet or judgment. |
| **FIR & Document Scan** | Decodes cited sections into a simple table showing **Bailable vs. Non-Bailable**, **Cognizable vs. Non-Cognizable**, and maximum penalty. | Audits FIR narrative against statutory ingredients; identifies unexplained filing delays, missing elements, and grounds for bail or quashment. | Generates a neutral **Charge-Framing Matrix** mapping prosecution allegations against required statutory ingredients. |
| **Voice-to-Text (STT)** | Push-to-talk voice questions in Bangla/English; voice-guided filling of basic General Diary (GD) templates. | Hands-free dictation of bail petitions, legal notices, argument notes, and witness summaries directly into a Case File. | Hands-free dictation of bench notes, draft order sheets, issue-framing lists, and judgment summaries. |

---

## 4. Detailed Functional Requirements

### 4.1 Module A: Automated BDLaws Scraper & Temporal Version Control Engine

The government portal (`bdlaws.minlaw.gov.bd`) hosts ~1,480+ Acts and Ordinances. When an existing law is amended by a new Act or Ordinance, the portal updates the consolidated text and appends legislative footnotes indicating what was substituted, inserted, or omitted.

```text
[Scheduled Crawler Polls bdlaws.minlaw.gov.bd Print View]
                           |
                           v
      [Parse Act -> Chapters -> Sections -> Footnotes]
                           |
                           v
   [Normalize Text & Compute Section-Level SHA-256 Hash]
                           |
             +-------------+-------------+
             |                           |
     (Hash Matches DB)           (Hash Differs from DB)
             |                           |
             v                           v
    [Skip Re-Indexing]      [Archive Old Section Version]
                            (Set Is_Current = False, Valid_To = Today)
                                         |
                                         v
                            [Insert New Amended Section Version]
                            (Set Version = N+1, Is_Current = True)
                                         |
                                         v
                            [Generate Multilingual Vector Embedding]
```

* **FR-A1 (Automated Statutory Harvesting):** The backend shall run a scheduled crawler that fetches the consolidated view of each Act from `bdlaws.minlaw.gov.bd`, preserving the exact hierarchy of **Act -> Part/Chapter -> Section -> Sub-section -> Amendment Footnotes**.
* **FR-A2 (Cryptographic Amendment Detection):** For every section, the system shall normalize whitespace/Unicode and compare its cryptographic hash against the currently active database record. Unchanged sections are skipped; modified sections trigger the versioning workflow.
* **FR-A3 (Non-Destructive Temporal Versioning):** When a new law amends an existing section, the old text is never deleted. It is archived with a validity date range (`Valid_From` to `Valid_To`), and the newly amended text is marked as the `CURRENT` version alongside the extracted amendment footnote.
* **FR-A4 (Point-in-Time Historical Law Lookup):** By default, all user queries retrieve the `CURRENT` version of the law. However, Lawyers and Judges can specify an **Offense Date** in a Case File to inspect the exact wording of the statute as it stood on the date of the alleged incident.

---

### 4.2 Module B: FIR & Legal Document Scanning Pipeline (OCR + Entity Analysis)

Users can scan physical documents using the mobile camera or upload PDF/DOCX/Image files from the web portal—specifically targeting **BP Form No. 24 (FIR / এজাহার)**, Charge Sheets (অভিযোগপত্র), Seizure Lists (জব্দ তালিকা), and Court Orders.

```text
[Mobile Camera Scan / Web File Upload (FIR, Charge Sheet, Petition)]
                                 |
                                 v
        [Image Deskew, Contrast Enhancement & Bilingual OCR]
        (Extracts Printed/Handwritten Bangla & English Text)
                                 |
                                 v
        [Legacy Font Normalization (Bijoy ANSI -> UTF-8 Unicode)]
                                 |
                                 v
        [Legal Entity Extractor (Dates, Parties, Police Station)]
                                 |
                                 v
        [Statutory Section Detector (e.g., Sec 302/34, Sec 420)]
                                 |
                                 v
        [Deterministic Join with CrPC Schedule II Database Table]
        (Retrieves Exact Bailable, Cognizable & Punishment Status)
                                 |
                                 v
        [Role-Specific AI Analysis (Citizen / Lawyer / Judge View)]
```

* **FR-B1 (Bilingual OCR & Encoding Normalization):** The OCR pipeline shall accurately read mixed Bengali and English legal documents, automatically converting legacy Bijoy/ANSI encodings into standard UTF-8 Bangla Unicode.
* **FR-B2 (Automated FIR Metadata Extraction):** When an FIR is uploaded, the system shall automatically extract and structure:
  * Name of Police Station (Thana), District, and FIR/G.R. Number.
  * Date & Time of Occurrence vs. Date & Time of Reporting (automatically calculating any delay in hours/days).
  * Names and roles of Informant/Complainant, Accused Persons, and Witnesses.
  * Cited Acts and Section Numbers (supporting both Bangla numerals like `ধারা ৪২০/৪০৬` and English numerals like `Section 420/406`).
* **FR-B3 (Deterministic CrPC Schedule II Verification):** Rather than asking an AI model to guess whether an offense is bailable, the system shall match every extracted section number against a pre-verified database table of **CrPC Schedule II** (and special tribunal schedules) to display 100% accurate tags for:
  * **Cognizable vs. Non-Cognizable** (আমলযোগ্য কি না)
  * **Bailable vs. Non-Bailable** (জামিনযোগ্য কি না)
  * **Compoundable vs. Non-Compoundable** (আপসযোগ্য কি না)
  * **Maximum Statutory Punishment & Triable Court**
* **FR-B4 (Ingredient & Loophole Audit):** For Lawyers and Judges, the system cross-checks the narrative summary of allegations against the mandatory statutory ingredients of each cited section (e.g., verifying whether the facts alleged in an FIR actually satisfy the legal definition of cheating under Section 415/420 of the Penal Code).

---

### 4.3 Module C: Voice-to-Text (STT) Query & Case File Dictation Engine

In Bangladesh, legal queries and courtroom drafting naturally blend Bengali and English terminology (code-switching). The Voice-to-Text subsystem is built to handle mixed-language speech accurately.

```text
[User Microphone (Web or Mobile App)]
                 |
      +----------+----------+
      |                     |
(Mode 1: Voice Query)  (Mode 2: Live Case File Dictation)
      |                     |
      v                     v
[Short Audio Upload]   [Real-Time WebSocket Audio Stream]
      |                     |
      +----------+----------+
                 |
                 v
[Bilingual ASR Engine (Bangla + English Code-Switched Speech)]
                 |
                 v
[Bangladesh Legal Glossary Post-Processor]
(Fixes phonetic terms: Ejahar, Khatian, CrPC, Sec 561A, Cognizable)
                 |
      +----------+----------+
      |                     |
(Mode 1 Output)       (Mode 2 Output)
      |                     |
      v                     v
[Executes RAG Search] [Streams Formatted Text into Case Editor]
```

* **FR-C1 (Voice Search Mode):** Any user can press and hold the microphone button to ask a legal question verbally in Bangla, English, or mixed speech. The backend converts the speech to text and streams back a citation-backed answer.
* **FR-C2 (Live Case File Dictation Mode):** Lawyers and Judges can open a document inside their Case File workspace and dictate bail petitions, plaints, witness examination notes, or court orders continuously via WebSocket streaming.
* **FR-C3 (Legal Vocabulary Auto-Correction):** A post-processing layer equipped with a **Bangladesh Legal & Revenue Glossary** automatically corrects phonetic misrecognitions of specialized words (e.g., *এজাহার, চার্জশিট, খতিয়ান, দাগ নম্বর, ফৌজদারি কার্যবিধি, দণ্ডবিধি, জামিনযোগ্য, Prima Facie, Quashment, Ad-interim*).
* **FR-C4 (Multi-Device Synchronization & Export):** Voice-dictated drafts and uploaded FIR analyses saved inside a Case File synchronize immediately between the Mobile App and Web App, and can be exported as formatted **DOCX** or **PDF** files.

---

### 4.4 Module D: Supreme Court Judgment (SCOB) Harvester & Case-Law Index

The Supreme Court of Bangladesh publishes selected reported judgments in the **Supreme Court Online Bulletin (SCOB)**, an online law report. The index page (`https://www.supremecourt.gov.bd/web/?page=bulletin.php&menu=10&lang=`) lists one entry per issue, currently from **1 SCOB 2015** to **20 SCOB 2025**, about one issue per year. Each issue has:

| Source Element | URL Pattern (relative to `/web/`) | Notes |
| :--- | :--- | :--- |
| Full-issue PDF | `../resources/bulletin/{issue}_SCOB_{year}.pdf` | Complete bound issue; kept for provenance only. |
| Appellate Division list (newer issues) | `?page=bulletin/bulletin_list_AD_{issue}.php&menu=00&div_id=1&issue={issue}` | `div_id=1` = Appellate Division. |
| High Court Division list (newer issues) | `?page=bulletin/bulletin_list_HD_{issue}.php&menu=00&div_id=2&issue={issue}` | `div_id=2` = High Court Division. |
| Division list (older issues, 1–14) | `?page=bulletin/bulletin_list.php&menu=00&div_id={1\|2}&issue={issue}` | Generic list template. |
| Individual judgment PDF | `../resources/bulletin/{issue}/{serial}. {issue} SCOB {AD\|HCD}-{serial}.pdf` (URL-encoded) | One PDF per reported judgment. |

> **As found (JUD-01, 2026-11-08):** judgment PDF names vary by issue (`20/1. 20 SCOB AD-1.pdf`, `20/01. 20 SCOB HCD.pdf`, `5_SCOB_AD_1.pdf`, `14_SCOB_HD_1.pdf`), so the crawler takes each href from the list row instead of building it. Issue 1 lists case numbers instead of parties and citation. 456 judgments in issues 1–20. Details: `apps/worker/src/scob/README.md`.

Each division list is a single page (no pagination) with one row per judgment, showing: **serial number, parties (Petitioner/Appellant Vs. Respondent), authoring judge, citation (e.g. `20 SCOB [2025] AD`), key words (statutes, sections and legal topics), a short summary, and the key-ratio paragraph number(s)**. The list does **not** show the decision date or case number; these must be taken from the judgment PDF.

```text
[Scheduled Crawler Polls SCOB Index Page]
                  |
                  v
[Discover Issues (issue no., year) -> AD & HCD List Pages]
                  |
                  v
[Parse Each Row: Serial, Parties, Judge, Citation, Key Words, Summary, Ratio Para, PDF URL]
                  |
                  v
[Download Judgment PDF -> Compute SHA-256 of File Bytes]
                  |
        +---------+---------+
        |                   |
 (Hash Matches DB)   (New or Changed PDF)
        |                   |
        v                   v
   [Skip]      [Store Original PDF in Vault]
                            |
                            v
          [Extract Text (PDF text layer; OCR fallback for scanned pages;
           Bijoy/ANSI -> Unicode for Bangla)]
                            |
                            v
          [Extract Case No., Decision Date, Bench, Paragraph Numbers]
                            |
                            v
          [Detect Cited Statutes & Sections -> Resolve to Statute_Sections]
                            |
                            v
          [Paragraph-Aware Chunking -> Multilingual Vector Embedding]
```

* **FR-D1 (Automated Judgment Harvesting):** The backend shall run a scheduled crawler that reads the SCOB index page, finds every issue and its Appellate Division and High Court Division lists (both the newer per-issue and the older generic list templates), and downloads each listed judgment PDF. The first run backfills all published issues (1 to the latest); later runs only pick up new issues and new or changed PDFs.
* **FR-D2 (Listing Metadata Capture):** For each judgment the crawler shall store, exactly as published: issue number, year, division (`AD`/`HCD`), serial number within the issue, parties, authoring judge, published citation, key words, summary, key-ratio paragraph number(s), and the source PDF URL.
* **FR-D3 (Full-Text Extraction):** The system shall extract the full text of each judgment PDF, keeping its numbered paragraphs, and shall derive the case number (e.g. *Criminal Appeal No. … of …*), decision date and bench composition. If the PDF has no usable text layer, the bilingual OCR pipeline (Module B) is used, including legacy Bijoy-to-Unicode conversion for Bangla judgments. Extraction failures are flagged for admin review and the judgment is not indexed until resolved.
* **FR-D4 (Change Detection & Idempotency):** A SHA-256 hash of the downloaded PDF bytes is stored per judgment. Re-crawls skip unchanged files. If a PDF at the same URL changes (e.g. a corrected upload), the previous text is kept as a superseded revision and the new text is re-extracted and re-indexed. A judgment is identified by `(issue_number, division, serial_number)`.
* **FR-D5 (Statute Cross-Referencing):** References to Acts and sections found in the key words and body text (e.g. *Penal Code s. 302*, *ধারা ৪২০*, *Article 102 of the Constitution*) shall be resolved to records in `Statutes` / `Statute_Sections` and stored as links. References that cannot be resolved are stored as unresolved text and are not shown as verified links.
* **FR-D6 (Case-Law Retrieval & Citation):** Judgments shall be indexed for hybrid (vector + keyword) search and can be filtered by division, year, judge, Act and section. When the assistant relies on a judgment it must cite it with the published SCOB citation, parties and paragraph number (e.g. `[Md. Humayun Kabir Vs. The State, 20 SCOB [2025] AD, para 74]`), linked to the stored judgment record. The statute side-panel verifier shall list the judgments linked to the section being viewed. If a linked section was amended after the judgment's decision date, the judgment is shown with a note that it was decided on an earlier version of the section.
* **FR-D7 (Respectful Crawling):** The crawler shall identify itself with a generic project User-Agent, respect `robots.txt`, limit itself to one request at a time with a delay between requests, retry with back-off, and run outside Bangladesh court working hours where practical.
* **Out of scope for MVP:** Bengali translations of judgments (a separate menu on the same site), unreported judgments, daily cause lists, and judgments of subordinate courts or tribunals.

---

## 5. Data Dictionary & Database Entity Specification

To maintain a clean separation between structured metadata and semantic search vectors, the backend uses eight core data entities (Entities 7 and 8 cover Supreme Court case law):

### 5.1 Entity 1: `Users`
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `user_id` | UUID (PK) | Unique identifier for each registered user. |
| `full_name` | String | User's full name. |
| `contact_identifier` | String (Unique) | Verified mobile phone number or email address. |
| `role` | Enum | `CITIZEN`, `LAWYER`, `JUDGE`, or `ADMIN`. |
| `verification_credential` | String (Nullable) | Bar Council Enrollment No. (for Lawyers) or Judicial ID (for Judges). |
| `preferred_language` | Enum | Default output language (`BN` or `EN`). |

### 5.2 Entity 2: `Statutes` (Master Law Index)
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `statute_id` | UUID (PK) | Internal unique identifier for the Act/Ordinance. |
| `bdlaws_act_id` | Integer (Unique) | Official numeric ID from `bdlaws.minlaw.gov.bd`. |
| `act_number` | String | Official legislative citation (e.g., *"Act No. XLV of 1860"*). |
| `title_en` / `title_bn` | Text | Official English and/or Bengali title of the statute. |
| `enacted_date` | Date | Date of original enactment/publication. |
| `status` | Enum | `ACTIVE` or `REPEALED`. |
| `last_synced_at` | Timestamp | Timestamp of the most recent automated check against `bdlaws`. |

### 5.3 Entity 3: `Statute_Sections` (Temporal Versioned Repository)
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `section_id` | UUID (PK) | Unique identifier for this specific version of a section. |
| `statute_id` | UUID (FK) | Reference to the parent Act in `Statutes`. |
| `chapter_reference` | String | Chapter number and heading. |
| `section_number` | String | Exact section/article identifier (e.g., `"302"`, `"561A"`, `"34"`). |
| `marginal_heading` | Text | Official title/heading of the section. |
| `content_body` | Text | Verbatim statutory text (including provisos and explanations). |
| `amendment_footnotes` | JSON Array | Structured list of legislative amendment notes attached to this section. |
| `content_hash` | String (SHA-256) | Cryptographic hash used to detect amendments during scraping. |
| `version_number` | Integer | Incremental version counter (`1, 2, 3...`). |
| `is_current` | Boolean | `TRUE` if currently in force; `FALSE` if superseded by a newer amendment. |
| `valid_from` / `valid_to` | Date | Effective date window for historical point-in-time legal retrieval. |
| `semantic_embedding` | Vector(1024) | Multilingual dense vector embedding for semantic RAG retrieval. |

### 5.4 Entity 4: `CrPC_Schedule_Metadata` (Deterministic Criminal Lookup)
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `schedule_id` | UUID (PK) | Unique row identifier. |
| `statute_id` | UUID (FK) | Reference to the Penal Code or Special Act. |
| `section_number` | String | Section number (e.g., `"420"`, `"302"`). |
| `is_cognizable` | Boolean | Whether police may arrest without a warrant. |
| `is_bailable` | Boolean | Whether bail is a matter of statutory right. |
| `is_compoundable` | Boolean | Whether the offense can be legally compromised/settled. |
| `max_punishment` | Text | Verbatim statutory maximum sentence and fine. |
| `triable_by_court` | Text | Competent court of trial (e.g., *Court of Session*, *Magistrate 1st Class*). |

### 5.5 Entity 5: `Case_Files` (Multi-Device Workspace Container)
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `case_file_id` | UUID (PK) | Unique identifier for a user's case folder. |
| `owner_user_id` | UUID (FK) | User who owns the case file (strictly tenant-isolated). |
| `case_number` | String | Official court/police reference (e.g., *"G.R. Case No. 412/2026"*). |
| `court_or_thana` | String | Name of the Court or Police Station. |
| `alleged_offense_date` | Date | Used to trigger historical law version lookup if needed. |

### 5.6 Entity 6: `Case_Artifacts` (Scanned FIRs, Docs & Voice Drafts)
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `artifact_id` | UUID (PK) | Unique identifier for the uploaded file or drafted document. |
| `case_file_id` | UUID (FK) | Parent Case File reference. |
| `artifact_type` | Enum | `FIR_SCAN`, `CHARGE_SHEET`, `VOICE_DICTATION_DRAFT`, `COURT_ORDER_NOTE`. |
| `file_storage_url` | URL | Encrypted object storage link for the image, PDF, or raw voice audio. |
| `raw_extracted_text` | Text | Raw output from Bilingual OCR or Voice-to-Text engine. |
| `structured_analysis` | JSON Object | Parsed FIR entities, delay metrics, and CrPC Schedule II matrix. |
| `editable_document_html` | Rich Text | Formatted draft editable across both Web and Mobile apps. |

### 5.7 Entity 7: `Judgments` (Supreme Court Case-Law Repository)
Public reference data (not tenant-scoped). Text chunks and their embeddings live in the vector index, keyed by `judgment_id` and paragraph number.

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `judgment_id` | UUID (PK) | Internal unique identifier for the judgment. |
| `source` | Enum | `SCOB` (room for other reporters later). |
| `issue_number` / `issue_year` | Integer | SCOB issue (e.g. `20`) and year (e.g. `2025`). |
| `division` | Enum | `AD` (Appellate Division) or `HCD` (High Court Division). |
| `serial_number` | Integer | Position of the judgment in the issue's division list. Unique together with `issue_number` and `division`. |
| `citation` | String | Citation exactly as published (e.g. *"20 SCOB [2025] AD"*). |
| `case_number` | String (Nullable) | Case reference taken from the PDF (e.g. *"Criminal Appeal No. 12 of 2024"*). |
| `parties` | Text | Parties as published (*"… Vs. …"*). |
| `authoring_judge` | String | Judge who wrote the judgment, as listed. |
| `bench` | JSON Array (Nullable) | All judges on the bench, taken from the PDF. |
| `decision_date` | Date (Nullable) | Date of judgment, taken from the PDF. |
| `key_words` | Text | Key words exactly as published. |
| `summary` | Text | Summary exactly as published. |
| `key_ratio_paragraphs` | JSON Array | Paragraph number(s) holding the key ratio (e.g. `["26", "27"]`). |
| `language` | Enum | `EN`, `BN` or `MIXED`. |
| `full_text` | Long Text | Extracted judgment text with paragraph numbers kept. |
| `source_pdf_url` | URL | Original PDF URL on `supremecourt.gov.bd`. |
| `stored_pdf_url` | URL | Copy of the original PDF in object storage. |
| `pdf_sha256` | String (SHA-256) | Hash of the downloaded PDF bytes, used for change detection. |
| `extraction_status` | Enum | `OK`, `OCR_USED`, `NEEDS_REVIEW`. Only `OK`/`OCR_USED` judgments are searchable. |
| `last_synced_at` | Timestamp | Most recent check against the SCOB site. |

### 5.8 Entity 8: `Judgment_Statute_References` (Case-Law to Statute Links)
| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| `reference_id` | UUID (PK) | Unique row identifier. |
| `judgment_id` | UUID (FK) | Reference to `Judgments`. |
| `statute_id` | UUID (FK, Nullable) | Resolved Act, or NULL if not resolved. |
| `section_number` | String (Nullable) | Section/article referred to (e.g. `"302"`, `"102"`). |
| `raw_reference_text` | Text | The reference exactly as it appears in the judgment or key words. |
| `paragraph_numbers` | JSON Array | Paragraphs of the judgment where the reference appears. |
| `found_in` | Enum | `KEY_WORDS` or `BODY`. |

---

## 6. Decoupled API Contract Overview (Web & Mobile Integration)

Both the Web and Mobile applications communicate exclusively through the following unified backend endpoints:

| Category | Protocol & Method | Endpoint Path | Purpose |
| :--- | :--- | :--- | :--- |
| **Auth & Roles** | `REST POST` | `/api/v1/auth/login` | Authenticates user and returns JWT with `CITIZEN`, `LAWYER`, or `JUDGE` role claims. |
| **Legal Assistant** | `SSE POST` | `/api/v1/assistant/query` | Accepts text or voice-transcribed query + optional `case_file_id`; streams citation-backed answer. |
| **Law Verification** | `REST GET` | `/api/v1/statutes/{act_id}/sections/{sec}` | Fetches verbatim law text, active status, and amendment history for the side-panel verifier. |
| **Case-Law Search** | `REST GET` | `/api/v1/judgments?q=&division=&year=&act_id=&sec=` | Searches Supreme Court judgments by text, division, year, Act and section. |
| **Judgment Detail** | `REST GET` | `/api/v1/judgments/{judgment_id}` | Returns judgment metadata, full text by paragraph, linked statute sections and the source PDF link. |
| **Case Workspace** | `REST POST/GET` | `/api/v1/cases` | Creates, lists, and synchronizes Case File containers across Web and Mobile devices. |
| **FIR / Doc Scan** | `REST POST` | `/api/v1/cases/{id}/documents/scan` | Uploads camera scan or PDF of an FIR/Document; triggers async OCR + Schedule II analysis. |
| **Voice Query** | `REST POST` | `/api/v1/voice/transcribe-query` | Converts push-to-talk audio recording into normalized Bangla/English legal search text. |
| **Live Dictation** | `WebSocket WSS` | `/api/v1/voice/stream-dictation` | Streams live microphone audio and returns real-time corrected legal text into the Case File editor. |
| **Document Export** | `REST POST` | `/api/v1/cases/{id}/artifacts/{art_id}/export` | Exports a voice-dictated or AI-assisted draft to a court-formatted DOCX or PDF file. |

---

## 7. Non-Functional Requirements & Legal Guardrails

1. **Zero-Hallucination Citation Enforcement:** Every statutory claim generated by the assistant must include a clickable citation tag (e.g., `[Section 497, Code of Criminal Procedure, 1898]`) linked directly to a verified record in the local `Statute_Sections` database. If no statutory provision matches the query, the system must explicitly state that no verified provision was found.
   * **Case-law citations** follow the same rule: every judgment the assistant refers to must be cited with its SCOB citation, parties and paragraph number and must match a stored `Judgments` record, checked server-side. The assistant must not invent case names or citations, and must not describe a holding that is not supported by the cited paragraph. Judgments support, but never replace, the citation of the statute itself.
2. **Cross-Lingual Semantic Retrieval:** Because colonial and pre-1987 laws on `bdlaws.minlaw.gov.bd` are published in English while post-1987 laws are predominantly in Bengali, the retrieval engine must support cross-lingual matching—allowing a user to ask a question in Bangla, retrieve an English statute (such as the Evidence Act, 1872), and receive an accurate explanation in Bangla.
3. **Strict Confidentiality & Tenant Isolation:** Uploaded FIRs, charge sheets, and voice-dictated case notes are strictly private to the uploading user (`owner_user_id`). User documents are encrypted at rest (AES-256) and are never shared across accounts or used to train global models.
4. **Target System Latency:**
   * **Legal Q&A First-Token Stream:** Under `1.5 seconds`.
   * **Live Voice Dictation Word Appearance:** Under `800 milliseconds`.
   * **Single-Page FIR Scan to Full Breakdown:** Under `6.0 seconds`.

---

## 8. Phased 12-Week MVP Delivery Roadmap

| Phase | Timeline | Core Engineering Milestones |
| :--- | :--- | :--- |
| **Phase 1: Corpus & Version Engine** | Weeks 1–3 | Build the `bdlaws.minlaw.gov.bd` scraper and SHA-256 amendment diffing pipeline; ingest the **Top 50 foundational statutes** (Penal Code, CrPC, CPC, Evidence Act, Limitation Act, Specific Relief Act, Nari-O-Shishu, Cyber Security Act, NI Act, Labour Act); populate the deterministic CrPC Schedule II lookup table. |
| **Phase 2: Role-Based RAG & Web App** | Weeks 4–6 | Build the core API gateway, hybrid vector + keyword retrieval engine, and role-specific prompt routers (`CITIZEN`, `LAWYER`, `JUDGE`); launch the Web Application with split-screen verbatim statute verification. Build the SCOB judgment harvester (Module D), backfill all published issues for both divisions, link judgments to statute sections and index them. |
| **Phase 3: FIR OCR & Voice Dictation** | Weeks 7–9 | Add case-law search, judgment citations in answers and the judgment viewer on the web (Module D); integrate the bilingual (Bangla/English) OCR pipeline, FIR entity extractor, and Schedule II joiner; deploy the real-time WebSocket Voice-to-Text dictation engine with the Bangladesh Legal Glossary post-processor. |
| **Phase 4: Mobile App & Full Rollout** | Weeks 10–12 | Connect the Mobile App (camera FIR scanner + push-to-talk voice assistant + case-law viewer) to the decoupled API backend; expand the scraper to index all ~1,480+ laws on `bdlaws`; conduct pilot testing with practicing lawyers. |