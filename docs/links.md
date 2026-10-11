# Links and finding Files

A Link labels a File with a Client System, entity type, entity id and role.
Links affect discovery only. Any known Client System can still view a File and
add or remove its Links, including Links naming another Client System.
All endpoints require `X-System-Code` and accept `X-Actor-Id` for auditing.

## Link on upload

Include an optional `link` in `POST /files` alongside the upload fields:

```json
{
  "filename": "cover.jpg",
  "contentType": "image/jpeg",
  "size": 1024,
  "visibility": "public",
  "retentionType": "permanent",
  "link": {
    "system": "IMS",
    "entityType": "product",
    "entityId": "42",
    "role": "cover"
  }
}
```

The Link is saved with the Pending upload, but the File appears in record
results only after confirmation. Rejection of the upload removes its Links.

## Add or remove a Link

Send the same Link object as the JSON body to:

- `POST /files/:id/links` to add a Link.
- `DELETE /files/:id/links` to remove that exact Link.

Both return 204. Adding an existing Link or removing an absent Link is harmless.
Removing a Link leaves the File and its other Links available. Changes require
an Active, unexpired File; unavailable or malformed File ids return 404.

Each actual change writes `file.link.added` or `file.link.removed` with the
File id, calling Client System, actor id and complete Link in the audit detail.
The optional upload Link also writes an addition entry. Repeated requests that
do not change a Link write no extra change entry. Link changes and their audits
commit together.

## Find Files for a record

```http
GET /files?system=IMS&entityType=product&entityId=42&role=cover
X-System-Code: POS
```

`system`, `entityType` and `entityId` are required. Omit `role` to include all
roles. Results contain each File once, even if multiple Links match.

The response is `{ "files": [...], "nextPage": "..." }`. Each File contains the
same metadata and Variants as the confirmation response. Use `GET /files/:id`
for its original viewing address. Pending, deleted and expired Files are
excluded.

Results are ordered by File id, with at most 50 Files per page. Pass the returned
`nextPage` value as `page` alongside the same filters to continue; a null marker
means the end. The marker remains usable if the preceding File is removed.
Paging traverses currently matching Files, not a frozen snapshot: concurrent
additions or Link changes may alter results.

Link fields must be non-empty strings and are trimmed; `system` must be a
registered Client System. Entity ids are strings, including numeric ids such
as `"42"`. Invalid Links, filters and page markers return 400 with an error
message.

Apply migration `0004_links.sql` before running the updated service. It adds
the Links table, uniqueness constraint, record lookup index and cascading
cleanup when a File row is removed.
