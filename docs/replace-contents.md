# Replace a File's contents

Any known Client System can replace an Active File's bytes without changing its id or address.

1. `POST /files/:id/replacement` with `{ "contentType": "image/png", "size": 1234 }` returns 201 with the
   File's metadata plus `uploadUrl` (PUT the bytes there with the declared content type). The bytes go to a
   staging object, not the live one. Requesting again replaces the earlier declaration.
2. `POST /files/:id/replacement/confirm` checks the staged object's size and type against the declaration. On a
   match it swaps the staged object over the original, regenerates Variants (removing stale ones if the new
   type is not a picture) and returns the File.

A mismatch returns 422, deletes the staging object, clears the request and leaves the live File untouched.
Confirming with nothing requested or uploaded returns 409. An abandoned request changes nothing.
Supplying `visibility` returns 400: Visibility never changes. Pending, expired and unknown Files return 404.

Public originals (set on confirm and on replace) and Variants are stored with `Cache-Control: public, max-age=300`, so a replaced picture shows
within about 5 minutes. Audit entries: `file.replacement_requested`, `file.replaced`, `file.replacement_rejected`.

Apply migration `0005_replacement.sql` before deploying.
