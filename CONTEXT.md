# file-storage

The company's single place to keep uploaded files for its applications. Applications hand it a file, attach it to their own records, and get back an address to show it from.

## Language

### Callers

**Client System**:
An application or service that uses file storage: POS, CRMS, IMS, HRMS, ECOM, PORTAL, AUTH, FILE_STORAGE or NOTIFICATIONS. Identifies itself on every request by its code.
_Avoid_: Source (audit-logs term), Tenant, Consumer, App

### Files

**File**:
One uploaded object, kept once no matter how many Client Systems use it. A product image uploaded by IMS and shown by POS, CRMS and ECOM is one File, viewable by every Client System.
_Avoid_: Upload, Attachment, Asset, Blob

**Visibility**:
Whether a File is Public (anyone with its address can view it, served through the CDN) or Private (viewable only through a short-lived signed address). Fixed when the File is created.
_Avoid_: Access level, Privacy

**Retention type**:
Whether a File is Permanent (kept until removed) or Temporary (removed automatically 7 days after upload unless promoted to Permanent). Set at upload.
_Avoid_: Lifetime, TTL, Expiry type

**Variant**:
A smaller copy of a picture File (small, medium or large), made automatically when the upload is confirmed. Has the same Visibility as its File and is removed with it. Only pictures have Variants.
_Avoid_: Thumbnail, Rendition, Resize

### Using a file

**Link**:
A label a Client System puts on a File to say which of its own records the File belongs to (a system, an entity type, an entity id and a role such as "cover image"). Used to find a record's Files. A Link does not control who may see the File: any Client System can view any File.
_Avoid_: Attachment, Reference, Association

**Delete**:
Removing a File for everyone, including its Links. The caller is responsible for not deleting a File another Client System still uses.
_Avoid_: Detach, Unlink, Purge

### Lifecycle

**Pending upload**:
A File whose upload address has been issued but whose bytes have not yet been confirmed. It becomes Active once the upload is confirmed, and is discarded if never confirmed.
_Avoid_: Draft, Incomplete

**Active file**:
A File whose bytes have been confirmed and which can be linked, viewed and changed.
_Avoid_: Ready, Completed

**Expire**:
The automatic removal of a Temporary File 7 days after upload, together with its Links.
_Avoid_: Purge, Clean up
