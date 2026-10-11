# Edit a File's details

Any known Client System can edit an Active File with `PATCH /files/:id`.
Send `X-System-Code` and optionally `X-Actor-Id`, as on upload and view requests.

```http
PATCH /files/<id>
X-System-Code: POS
X-Actor-Id: user-1
Content-Type: application/json

{ "filename": "cover.png", "retentionType": "temporary" }
```

Supply `filename`, `retentionType`, or both. Filenames must be non-empty strings
and are trimmed. Retention type is `permanent` or `temporary`.

Promoting a Temporary File to Permanent clears its expiry. Demoting a Permanent
File to Temporary sets expiry seven days from the edit. Sending the current
Retention type or editing only the filename preserves the existing expiry.

A successful edit returns 200 with the File's metadata, including `filename`,
`retentionType`, `expiresAt` (an ISO timestamp or null) and `variants`.
The next view returns the saved details. The File id and original address remain
stable. Each successful edit writes a `file.edited` audit entry with the Client
System, optional actor id and resulting filename, Retention type and expiry.

Supplying `visibility` returns 400 with `Visibility cannot be changed after a
File is created`. Empty edits, unsupported fields and invalid values also return
400. A refused edit applies no changes and writes no edit audit entry.
Pending uploads, expired Files and unknown ids return 404 for valid edits.
