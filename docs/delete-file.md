# Delete a File

```http
DELETE /files/:id
X-System-Code: POS
X-Actor-Id: user-8
```

Any known Client System can delete a File for everyone, including a File created
by another Client System. The caller is responsible for checking whether other
Client Systems still use it. `X-Actor-Id` is optional.

A successful delete returns 204 with no body. Before replying, the service
removes all objects under the File's prefix from its Public or Private R2 bucket
(including Variants), removes every Link, and marks the retained File row
`deleted`. The metadata and Variant history remain available to operators in the
database. A `file.deleted` audit entry records the File id, calling system code
and actor id. The row change, Link removal and audit commit together.

Deleted Files return 404 when viewed, confirmed, edited or linked, and never
appear in record results. Deleting an already-deleted File returns 204 without
another audit entry. Pending uploads and expired Files can also be deleted.
Malformed or unknown File ids return 404; missing or unknown system codes return
401.

Deletion serializes with confirmation, edits and Link changes. R2 failures,
including per-object failures in a batch response, return 500 without committing
the Deleted status. Retry the same request: already-removed objects are harmless.
Storage and Postgres cannot commit atomically, so a failed attempt may have
removed some objects even though the File has not yet been marked Deleted.

This removes R2 objects, not copies already cached by a browser or CDN. Previously
issued upload addresses remain usable until their 15-minute expiry; a late PUT
can write bytes again, but confirmation cannot reactivate the deleted File.

Apply migration `0005_deleted_files.sql` before deploying the endpoint. It adds
`deleted` to the allowed File statuses without modifying existing rows.
