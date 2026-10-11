# ADR 0326: Switch a logical project's primary folder from Edit project

- Status: Accepted (amends ADR 0249 §6; addresses #1535)
- Date: 2026-10-11
- Deciders: PI-Desktop maintainers
- Related: ADR 0249, ADR 0233, ADR 0263, issue #1535

## Context

ADR 0249 fixed the first folder of a logical project group as its primary root
and made that root non-removable: `project.group.update` keeps the stored
primary, requires it to still be listed, and derives the new primary from the
first folder of the update. Edit project therefore showed the primary row with a
lock hint and offered no way to change which folder is primary.

That restriction stops being harmless when the primary folder no longer exists
on disk. The dialog cannot drop it, because no other row can be promoted to
primary, and it cannot keep it, because both the Electron main handler
(`projectGroupUpdate` rejects any folder that is not an existing directory) and
host-core (`project.group.update` rejects any root that is not a directory)
refuse the update. The project then cannot be saved at all: even a rename fails,
and no UI path can repair the group.

The gap is structural, not a permission problem. The renderer already knows the
group's primary path, the host already reorders the stored roots so the primary
leads, and the IPC contract is unchanged — only the dialog had no way to say
which folder the user means.

## Decision

1. Edit project offers **Make primary** on every non-primary folder row. The
   action moves that folder to the top of the visible list and makes it the
   dialog's primary, without persisting anything until the user saves.
2. Saving sends the folder list with the primary folder first. The host keeps
   deriving the primary root from the first folder of the update, so no IPC,
   RPC, or storage change is required: `project.group.update` keeps its
   `{ groupId, name, folders }` shape and unchanged validation.
3. The primary row itself stays non-removable, so a group always has exactly one
   primary folder. With `Make primary` available, a folder — including one that
   was moved or deleted on disk — can be retired by promoting another folder and
   then removing the stale row.
4. The dialog reorders the list immediately on click, mirroring the
   create-project dialog's rule that the first listed folder is the primary one.

## Consequences

- A project whose primary folder is missing becomes editable again, so the
  earlier "remove the folder, or replace the path" dead end no longer exists.
- The user can change the group's default execution root and side-browser base
  for future work. That is the intent of the action; it is not a data rewrite.
  Sessions keep the project path they were created with, and group membership,
  instructions, memory, transcripts, and on-disk folders are untouched.
- Stored group records, renderer metadata, and the host capability surface are
  unchanged, so existing databases and older renderers keep working.
- ADR 0249's consequence that the primary root "cannot be reordered in this
  iteration" is retired for the Edit project surface. Pointer reordering of the
  folder list remains out of scope; `Make primary` is the only ordering action.

## Alternatives considered

- **Relax the host and main-process existence checks for non-existing folders:**
  rejected. Registering a folder that is not a directory would let a broken
  group reach agent launch, workspace resolution, and the file surfaces, which
  is a worse failure than refusing the update.
- **Allow removing the primary row and promote the next folder implicitly:**
  rejected. The stored primary would then change as a side effect of an
  unrelated removal, and the dialog would show a primary the user never chose.
- **Add a `primaryPath` field to `project.group.update`:** rejected for now. The
  first-folder rule already expresses the same decision, and widening the IPC
  payload would create two sources of truth for the primary root.
