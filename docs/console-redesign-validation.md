# Console redesign validation

Historical record from the console-only work before release integration. For the merged candidate and current validation, see [0.9.0](releases/0.9.0.md).

Scope: the local console frontend. Existing APIs, permissions, project boundaries and embedded external employee apps retain their contracts. No Git commit, push or package publication is part of this change.

## Result

- Rebuilt the shell, home page, Agent cards and profile layout with one light neutral and blue palette.
- Added shared tokens, control styles, disclosure and button components. Replaced global loading with one three-arc mark, delayed display and reduced-motion support.
- Collapsed secondary settings, history and technical detail. Removed old overview styles, unused copy, decorative directory watermarks and duplicate primary control definitions.
- Adapted cards, navigation, knowledge lists, connection actions and settings to narrow screens. Graph labels now follow zoom level.
- Added an attention-request queue with mobile selection labels, kind-based reply choices and a separate submit action. Only explicit consecutive lettered alternatives in source text become choices; procedural steps remain unchanged. Drafts are isolated by request and revision.
- Agent cards measured 276px tall on desktop with 16px grid spacing. The About page keeps its dark treatment through the closing section, which remains visible and links to the official site.

## Automated checks

- Node 24: type checking and the production build passed.
- Final web regression suite: 71 files, 394 tests passed.
- HTTP request boundaries: 10 checks passed, including dotted Agent identities and missing-asset behavior. Source structure: 2 checks passed. Whitespace validation passed.
- Regression coverage includes foreign-space filtering, per-request revision warnings, independent drafts, stale-operation locks, refresh/submission distinction and confirmed replies followed by a failed refresh.

## Browser checks

Checked the live interface at 1440, 768 and 390 pixels wide using the in-app browser after the regular Chrome session blocked the local URL.

- Agent cards use three, two and one columns; search, profile links and the hire dialog work.
- Profile tabs support arrows, Home and End with one tab stop. Project disclosures retain navigation.
- Home task links select the correct Agent and reveal the requested task details.
- Mobile navigation opens, closes on navigation and responds to Escape.
- Knowledge filters expand; graph zoom and fit work. Dense graph labels collapse while accessible names remain available.
- Settings disclosures expose fields; invalid hidden fields open their parent section in regression coverage.
- Connection editing opens and cancels without writing data. Narrow-screen action buttons no longer compress connection names.
- At 390×600, temporarily blocking the attention-list request showed the error banner. The dialog, detail pane and submit control ended at 592px, 591px and 571px respectively, with no clipping; the block was then removed. At 390px, the About page's official-site link remained visible with no horizontal overflow, and the entire About view contained no disclosure controls.

Contract validation confirms the shared identity filter covers authorized roles, and bounded responses are marked partial rather than idle.

## Independent review

Cursor completed a real Chrome review of home, Agent directory, profile collaboration, attention replies and About at 1440px and simulated 390×844 / 390×600. It confirmed card density, scoped drafts, reply selection, reachable submission controls and the complete About closing section. It identified profile deep-link refreshes returning 404 and keyboard-selected tabs remaining outside the mobile viewport. Both have regression fixes and passed Cursor’s final live Chrome recheck at 390×600: the profile loaded after refresh, and keyboard-selected tabs scrolled fully into view. No real attention reply was submitted.

## Execution record

| Work | Actual executor | Result | Reported tokens |
| --- | --- | --- | --- |
| Frontend inventory | Codex native worker | Completed | Not reported |
| Agent cards and profiles | Codex native worker | Completed | Not reported |
| Workspace and task navigation | Codex native worker | Completed | Not reported |
| Loading and shared controls | Codex native worker | Completed | Not reported |
| Independent source review and graph labels | Codex native worker | Completed | Not reported |
| Independent source review | Cursor desktop | First-round two findings fixed | Not reported |
| Screenshot-based UI review | Cursor desktop, connected Chrome | Completed; both findings fixed and rechecked | Not reported |

## Boundaries

Real destructive actions, permission changes and production task mutations were not used for browser testing; their frontend behavior is covered by existing and added automated tests. Provider data and configuration were preserved.

The verified frontend build was applied to the existing local service static directory with a rollback copy. The served entry document and entry assets match the build. The narrowly scoped static-handler route fix was applied after verifying the installed handler matched outside that function. The console was restarted through its lifecycle with Provider stopping disabled; the graph services remained running. LAN mode remained enabled; its temporary access code rotates on restart. No package version change, Git commit or publication was performed.
