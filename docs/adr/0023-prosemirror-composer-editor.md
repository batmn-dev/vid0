# ADR 0023: ProseMirror owns the composer editing DOM

## Status

Accepted.

## Context

The Composer owns a plain-string draft, attachment capture, and the complete
Chat turn payload. Its textarea duplicated browser-sensitive editing work for
multiline DOM, selection restoration, IME composition, paste normalization,
and external draft replacement. A stable ProseMirror contenteditable handles
those browser contracts while retaining a non-interactive textarea fallback.

## Decision

`PromptInputTextarea` keeps its public component name for compatibility but
renders a ProseMirror editor with paragraphs, headings (levels 1–3),
strong/emphasis/link marks, lists, hard breaks, and protected typed inline
entities. The draft remains a Markdown string; unformatted drafts retain exact
whitespace and paragraph boundaries serialize to `\n`. Entity atoms are
presentation projections of typed Composer capabilities and never enter
submitted text. Composer, draft persistence,
attachment handling, and Chat turn payloads therefore continue to own ordinary
strings. The editor exposes the imperative `focus`, `setSelectionRange`,
and `replaceActionQuery` commands Composer already requires.

The EditorView owns its DOM through a callback ref and is synchronized before
paint through the repository's browser-layout lifecycle. Input transactions
write through the existing `onValueChange` port. External draft changes replace
the editor document without entering undo history. No React `useEffect` or
timeout coordinates editor state.

Capability entities use a sibling DOM projection: an invisible
leading cursor-target node, one protected entity atom, and an initial
structural spacer. Deleting the spacer exposes a trailing cursor-target widget
decoration at the collapsed selection; the next Backspace deletes the complete
entity without requiring ArrowLeft, while typed input replaces that decorated
boundary. Keeping the trailing target outside the document also groups both
Backspaces into one history event. A ProseMirror keymap deletes the structure
atomically, an appended transaction normalizes orphaned leading boundaries,
and the history plugin restores the initial entity plus spacer. Selection
decorations project native range selection onto the atom with
`data-inline-selection-pill-selected`; React does not mirror editor selection.
The editor also derives a typed `@query` from the collapsed ProseMirror
selection. A query begins only at a text boundary, stays in one editor-owned
session while its text changes, and is replaced by an action result in one
transaction. Composer presents that query through the shared action registry;
Escape dismisses the current session without changing text or focus, and a new
session can open discovery again. This keeps keyboard filtering, activation,
undo, and entity insertion on the same document transaction boundary.

ProseMirror's raw-widget separator image is hidden inside the editor scope. It
is a cursor-addressing sentinel, not content; allowing the global image reset
to make it block-level would add a false line while deleting an entity spacer.

A `display: none` textarea with fallback field attributes remains
beside the contenteditable. The app clones the visible editing DOM at the derived compact width for
multiline expansion, so hidden link destinations and Markdown delimiters
cannot change the measured text width.

## Alternatives considered

- Keep the native textarea. Rejected because it cannot preserve a stable editor
  DOM and paragraph model across controlled draft replacement.
- Build a hand-rolled contenteditable. Rejected because IME, undo, selection,
  paste, and browser mutation reconciliation would become local editor code.
- Adopt a richer editor framework such as Tiptap or Lexical. Rejected because
  the existing ProseMirror editor already owns selection and entities.
- Implement Markdown mark escaping or list transforms locally. Rejected after
  literal punctuation, nested lists, and whitespace exposed round-trip errors.
  Maintained ProseMirror packages supply these editing and serialization rules.

## Consequences

- Chat data and turn contracts do not change.
- The contenteditable DOM and selection survive controlled value updates.
- Undo, IME, paragraph editing, and browser mutation reconciliation come from
  ProseMirror instead of local DOM code.
- Rich formatting survives draft persistence and submission through Markdown.
  The supported Markdown subset is restored using the existing remark parser;
  unsupported blocks remain literal text. No parallel JSON draft is stored.
- Capability selection, deletion, and undo remain Editor transactions, so the
  typed Composer state and protected DOM cannot diverge.
- `prosemirror-model`, `prosemirror-state`, `prosemirror-view`, commands,
  keymap, history, schema-list, inputrules, and markdown are direct client
  dependencies.

## Rich formatting interactions

A ProseMirror plugin owns the selection toolbar and link editor. This keeps
native selection, pressed state, focus restoration, and undo on the same
transaction boundary as typing. The toolbar offers links, bold, italic,
headings, and ordered/bulleted lists; link previews support edit, clear, copy,
and open. Enter retains the existing send behavior. Shift+Enter continues a
list or exits an empty item; after a heading it creates a paragraph. Standard
input rules recognize heading/list prefixes and emphasis syntax.
Blank formatted drafts serialize only their whitespace, so formatting markers
cannot enable Send. Their active heading or list remains in the editor.
An empty heading's placeholder uses paragraph typography and spacing, so the
composer returns to its normal empty height before heading text is typed again.

The Markdown boundary uses the maintained `prosemirror-markdown` inline
serializer, including delimiter escaping and surrounding-whitespace handling.
A small block adapter retains the composer's existing single-newline and empty
paragraph behavior. Entity changes transact in place without reconstructing
formatted content. Serialized-offset mappings resolve to text positions even
inside nested list structure.
List boundaries add the structural blank lines Markdown requires; parsing
consumes those separators without adding empty editor paragraphs.

Sent user messages render semantic React elements from this same parsed document.
Unmarked paragraphs retain literal whitespace; headings, lists, and marks use
the measured user-message styles. Re-parsing with the assistant's Markdown
grammar was rejected because it interprets literal math and indented text
differently from the composer. Copy and edit retain the canonical string, and
editing reuses the composer with Enter inserting a line and Mod+Enter submitting.
