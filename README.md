# Clinical Form Completion Tool

A clinician-facing web application that maps unstructured clinical notes into the fields of an uploaded fillable PDF. Claude proposes field values, the clinician reviews and edits every proposed value, and the browser generates the completed PDF.

## What changed from the prototype

- The Anthropic API key is stored on the server, never entered into browser code.
- Claude uses JSON Schema Structured Outputs instead of best-effort JSON prompting.
- Every returned field name and value is validated against the actual PDF metadata.
- A mandatory human-review screen appears before the PDF is generated.
- Text fields, checkboxes, radio groups, dropdowns, and option lists are supported.
- Signature fields, buttons, unknown field types, invalid options, and overlength values are reported instead of silently skipped.
- Password-protected, non-PDF, oversized, and non-fillable files receive clear errors.
- Generated field appearances are updated for better PDF-viewer compatibility.
- The completed form can remain editable or be flattened.
- Automated tests cover discovery, filling, validation, flattening, and non-fillable PDFs.

## Requirements

- Node.js 20.19 or newer
- An Anthropic API key
- A fillable AcroForm PDF

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` from `.env.example` and add the server-side API key:

   ```env
   ANTHROPIC_API_KEY=sk-ant-your-key
   ANTHROPIC_MODEL=claude-sonnet-5
   PORT=8787
   ```

3. Start the Vite frontend and API server together:

   ```bash
   npm run dev
   ```

4. Open the Vite URL shown in the terminal, normally `http://localhost:5173`.

The browser calls `/api/map-fields`. During development, Vite proxies that path to the local API server on port 8787.

## Deploying to Vercel

This repository is ready for Vercel's Vite support and includes the API route as a Vercel Function.

1. Import this GitHub repository into Vercel.
2. Keep the detected framework preset as **Vite**.
3. In **Project Settings → Environment Variables**, add:

   ```env
   ANTHROPIC_API_KEY=your-real-key
   ANTHROPIC_MODEL=claude-sonnet-5
   ```

   Add the variables to both **Preview** and **Production** if you want branch previews to work.

4. Deploy. Vercel will run `npm install` and `npm run build` automatically.
5. Before testing a form, open `/api/health` on the deployed domain. It should return `{"ok":true,"configured":true}`.

Vercel Functions have a 4.5 MB request limit. Because PDFs are base64-encoded before transmission, this deployment accepts PDFs up to 3 MB. Larger clinical documents would require an approved private-storage upload workflow and a separate privacy/security review.

## Other Node hosting

Build and run the combined server:

```bash
npm run build
npm start
```

The Node server serves the generated `dist` directory and the API from the same origin. Most hosting platforms supply `PORT`; set `ANTHROPIC_API_KEY` through the platform's secret manager, never in the Git repository or client-side environment variables. Vercel uses the functions in `api/` instead of this long-running server.

Before exposing this application publicly, add organization-appropriate authentication, authorization, rate limiting, audit controls, encrypted storage rules, monitoring, and a formal privacy/security review. The current app does not intentionally persist uploaded PDFs or notes and does not log their content, but infrastructure and API-provider configurations still matter.

## Testing

Run the automated PDF tests:

```bash
npm test
```

The test suite programmatically generates a fillable PDF, fills every supported field type, reopens the completed PDF, and verifies the stored values.

## Supported PDF fields

| Field type | Behaviour |
|---|---|
| Text | Filled when within the PDF's maximum length |
| Checkbox | Accepts explicit yes/no values |
| Radio group | Requires an existing PDF option |
| Dropdown | Requires an existing PDF option |
| Option list | Supports single or multiple selections according to the form |
| Signature | Never filled automatically |
| Button | Ignored because it does not hold clinical data |

## Important limitation: flattened or scanned forms

This version fills AcroForm fields. A scanned or flattened PDF contains no interactive field objects, so there is no reliable target in which to place the values. The app detects that condition and stops with a clear message instead of creating an apparently successful but blank PDF.

Supporting arbitrary flat forms is a separate coordinate-mapping feature. It requires page rendering/OCR, bounding-box review, and overlay placement tests for each form layout. It should not be treated as equivalent to AcroForm filling without that review layer.

## Clinical safety

Claude's output is a proposal, not the completed clinical document. The application assigns confidence indicators, preserves unsupported values as blank, blocks automated signatures, and requires review before generation. The clinician remains responsible for confirming the source facts, field meaning, selected options, and final PDF.

## Semantic matching

Claude matches form fields using healthcare context, including standard clinical abbreviations, equivalent clinical terms, administrative synonyms, negation, and the meaning of supplied form options. Examples include `HTN` → `Hypertension`, `T2DM` → `Type 2 diabetes`, `NKDA` → `No known drug allergies`, `BID` → `Twice daily`, `WBC` → `white blood cell count`, and `phone number` → `tel`.

Every proposed value must include a short verbatim passage from the clinical note. The server rejects evidence that is not present in the note, caps semantic matches below the low-confidence threshold, and labels them **Healthcare semantic match — confirm**. The review screen shows the source passage and identifies it as patient-reported, clinician-observed, or otherwise documented in the note.

Safety rules prevent family history from becoming a patient diagnosis, suspected diagnoses from becoming confirmed diagnoses, discontinued medicines from becoming current medicines, and adverse effects from becoming allergies without explicit documentation. The model must also distinguish a negative finding from missing information, and it must never infer sensitive attributes or diagnose a condition from symptoms alone. Unknown, contradictory, or unsupported values remain blank.

This feature is a clinician-reviewed mapping aid, not a complete medical ontology or an autonomous diagnostic system. Healthcare semantic matches always require human confirmation before the PDF is generated.

## Disability and functional context

The same semantic layer recognizes explicitly documented disability and functional context across ADLs and IADLs, mobility and gait aids, transfers, physical and cognitive tolerances, communication, sensory function, endurance, episodic limitations, participation, and workplace or school accommodations. It can map statements such as `needs help bathing`, `cannot stand longer than 10 minutes`, `uses a walker`, or `symptoms flare unpredictably` to compatible form fields and supplied options.

The safety rules do not treat a diagnosis as proof of disability, convert symptoms into unstated restrictions, present a patient report as a clinician observation, or equate modified duties with inability to work. The model cannot determine legal, insurance, workplace, tax-credit, or benefit eligibility, and it cannot infer permanence, prognosis, duration, or return-to-work dates. Unsupported conclusions remain blank for clinician review.

## Main files

- `src/App.jsx`: browser workflow and human review screen
- `src/pdf-form.js`: PDF inspection, validation, and filling
- `server/index.js`: server-side Claude request and static hosting
- `api/map-fields.js`: Vercel Function for server-side Claude requests
- `api/health.js`: Vercel configuration health check
- `test/pdf-form.test.js`: generated-PDF automated tests
- `.env.example`: safe environment-variable template
