# Verification requirements

These are acceptance requirements, not completed results. Record observed runs locally and update public implementation status only after verification. Source tests may contain small synthetic inputs. Private recordings, real shop data, and test evidence exports are not repository assets.

| Area | Required observation |
| --- | --- |
| Local model | A real Firebase AI Logic request reports ON_DEVICE and succeeds while disconnected |
| Cloud model | A permitted real request reports IN_CLOUD |
| Offline restart | Prepare, close the browser, disconnect, reopen the app, and access the saved catalog |
| Manual checkout | Ordinary buttons produce the same totals as validated shorthand input |
| Saved sale | A confirmed cash sale and queue entry survive a reload |
| Interpretation | Evaluate labeled quantity, modifier, ambiguity, and correction cases; report failures |
| Authority | Invented items, prices, payment fields, invalid quantities, and malformed JSON are rejected |
| Payment | Imported unresolved payment states remain unresolved |
| Retry | A server commit followed by a lost response and retry creates one native sale |
| Conflicting retry | Reusing a sale ID with changed data returns a conflict |
| Batch recovery | A partially imported batch resumes without duplicating completed sales |
| Catalog drift | Removed items or mismatched historical prices become visible exceptions |
| Historical behavior | Recovery does not fire kitchen tickets or initiate payment charges |
| Access | A revoked backend permission blocks import without erasing local sales |
| Storage failure | A failed local transaction does not display a saved receipt |
| Fresh setup | Public instructions suffice without private team documents or real customer exports |

Before submission, complete application install/run instructions, an open-source code review, isolated judge access, an English or subtitled video within the stated limit, and disclosure of any incorporated pre-existing POS work. Keep the functional project available through the judging period. [Official submission rules](https://firebasehybridaihackathon.devpost.com/rules).
