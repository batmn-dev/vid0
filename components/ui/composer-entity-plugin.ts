import { selectedEntityClassName } from "@/components/ui/composer-entity-pill"
import { promptInputSchema } from "@/components/ui/prompt-input-schema"
import type { Node as ProseMirrorNode } from "prosemirror-model"
import { Plugin, type EditorState, type Transaction } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"

type DeletionRange = { from: number; to: number }

/**
 * Mention-pill mechanics on top of the Composer schema: atomic deletion of the
 * cursor-target/entity/spacer triple, selection decorations, and the appended
 * transaction that repairs pill structure after arbitrary edits.
 */

function getPromptInputEntitySelectionDecorations(state: EditorState) {
  const decorations: Decoration[] = []
  if (state.selection.empty) {
    const entity = state.selection.$from.nodeBefore
    if (
      entity?.type === promptInputSchema.nodes.composerEntity &&
      state.selection.$from.nodeAfter === null
    ) {
      decorations.push(
        Decoration.widget(
          state.selection.from,
          () => {
            const cursorTarget = document.createElement("span")
            cursorTarget.ariaHidden = "true"
            cursorTarget.contentEditable = "false"
            cursorTarget.dataset.inlineSelectionPillCursorTarget = ""
            cursorTarget.textContent = "\uFEFF"
            return cursorTarget
          },
          {
            key: `composer-entity-cursor-target:${entity.attrs.id}`,
            raw: true,
            side: 1,
          }
        )
      )
    }
  } else {
    state.doc.nodesBetween(
      state.selection.from,
      state.selection.to,
      (node, pos) => {
        if (
          node.type === promptInputSchema.nodes.composerEntity &&
          state.selection.from <= pos &&
          state.selection.to >= pos + node.nodeSize
        ) {
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: selectedEntityClassName,
              "data-inline-selection-pill-selected": "",
            })
          )
        }
      }
    )
  }

  return decorations.length > 0
    ? DecorationSet.create(state.doc, decorations)
    : null
}

function getEntityDeletionRange(
  state: EditorState,
  entityPos: number,
  entity: ProseMirrorNode
) {
  let from = entityPos
  let to = entityPos + entity.nodeSize
  const before = state.doc.resolve(entityPos).nodeBefore
  if (
    before?.type === promptInputSchema.nodes.composerEntityCursorTarget &&
    before.attrs.entityId === entity.attrs.id
  ) {
    from -= before.nodeSize
  }

  const after = state.doc.resolve(to).nodeAfter
  if (after?.isText && after.text?.startsWith(" ")) {
    to += 1
  }
  return { from, to }
}

function mergeDeletionRanges(ranges: readonly DeletionRange[]) {
  const merged: DeletionRange[] = []
  for (const range of ranges
    .slice()
    .sort((left, right) => left.from - right.from)) {
    const previous = merged[merged.length - 1]
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

function excludeDeletionRanges(
  ranges: readonly DeletionRange[],
  protectedRanges: readonly DeletionRange[]
) {
  return ranges.flatMap((range) => {
    let fragments = [range]
    for (const protectedRange of protectedRanges) {
      fragments = fragments.flatMap((fragment) => {
        if (
          protectedRange.to <= fragment.from ||
          protectedRange.from >= fragment.to
        ) {
          return [fragment]
        }
        return [
          ...(protectedRange.from > fragment.from
            ? [{ from: fragment.from, to: protectedRange.from }]
            : []),
          ...(protectedRange.to < fragment.to
            ? [{ from: protectedRange.to, to: fragment.to }]
            : []),
        ]
      })
    }
    return fragments
  })
}

function deleteSelectedComposerEntities(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void
) {
  if (state.selection.empty) return false

  const deletionRanges: DeletionRange[] = [
    { from: state.selection.from, to: state.selection.to },
  ]
  const protectedRanges: DeletionRange[] = []
  let containsComposerEntity = false
  state.doc.nodesBetween(
    state.selection.from,
    state.selection.to,
    (node, pos) => {
      if (
        node.type === promptInputSchema.nodes.composerEntity &&
        state.selection.from <= pos &&
        state.selection.to >= pos + node.nodeSize
      ) {
        containsComposerEntity = true
        if (node.attrs.removable === false) {
          protectedRanges.push(getEntityDeletionRange(state, pos, node))
        } else {
          deletionRanges.push(getEntityDeletionRange(state, pos, node))
        }
      }
    }
  )
  if (!containsComposerEntity) return false

  const ranges = excludeDeletionRanges(
    mergeDeletionRanges(deletionRanges),
    protectedRanges
  )

  if (dispatch && ranges.length > 0) {
    const transaction = state.tr
    for (const range of ranges
      .slice()
      .sort((left, right) => right.from - left.from)) {
      transaction.delete(range.from, range.to)
    }
    dispatch(transaction.scrollIntoView())
  }
  return true
}

function deleteComposerEntityBackward(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void
) {
  if (deleteSelectedComposerEntities(state, dispatch)) return true
  if (!state.selection.empty) return false

  const entity = state.selection.$from.nodeBefore
  if (entity?.type !== promptInputSchema.nodes.composerEntity) return false
  if (entity.attrs.removable === false) return true
  const entityPos = state.selection.from - entity.nodeSize
  const range = getEntityDeletionRange(state, entityPos, entity)
  dispatch?.(state.tr.delete(range.from, range.to).scrollIntoView())
  return true
}

function deleteComposerEntityForward(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void
) {
  if (deleteSelectedComposerEntities(state, dispatch)) return true
  if (!state.selection.empty) return false

  const target = state.selection.$from.nodeAfter
  if (target?.type !== promptInputSchema.nodes.composerEntityCursorTarget) {
    return false
  }
  const entityPos = state.selection.from + target.nodeSize
  const entity = state.doc.resolve(entityPos).nodeAfter
  if (
    entity?.type !== promptInputSchema.nodes.composerEntity ||
    entity.attrs.id !== target.attrs.entityId
  ) {
    return false
  }
  if (entity.attrs.removable === false) return true

  const range = getEntityDeletionRange(state, entityPos, entity)
  dispatch?.(state.tr.delete(range.from, range.to).scrollIntoView())
  return true
}

function normalizeComposerEntityStructure(
  transactions: readonly { docChanged: boolean }[],
  _oldState: EditorState,
  newState: EditorState
) {
  if (!transactions.some((transaction) => transaction.docChanged)) return null

  const operations: Array<
    | { kind: "delete"; from: number; to: number }
    | { kind: "insert"; pos: number; node: ProseMirrorNode }
  > = []

  newState.doc.descendants((paragraph, paragraphOffset) => {
    if (!paragraph.isTextblock) return true
    paragraph.forEach((node, childOffset, index) => {
      const pos = paragraphOffset + 1 + childOffset
      if (node.type === promptInputSchema.nodes.composerEntityCursorTarget) {
        const entity =
          index + 1 < paragraph.childCount ? paragraph.child(index + 1) : null
        if (
          entity?.type !== promptInputSchema.nodes.composerEntity ||
          entity.attrs.id !== node.attrs.entityId
        ) {
          operations.push({
            kind: "delete",
            from: pos,
            to: pos + node.nodeSize,
          })
        }
        return
      }

      if (node.type !== promptInputSchema.nodes.composerEntity) return
      const target = index > 0 ? paragraph.child(index - 1) : null
      if (
        target?.type !== promptInputSchema.nodes.composerEntityCursorTarget ||
        target.attrs.entityId !== node.attrs.id
      ) {
        operations.push({
          kind: "insert",
          pos,
          node: promptInputSchema.nodes.composerEntityCursorTarget.create({
            entityId: node.attrs.id,
          }),
        })
      }
    })
    return false
  })

  if (operations.length === 0) return null
  const transaction = newState.tr
  for (const operation of operations.slice().sort((left, right) => {
    const leftPos = left.kind === "delete" ? left.from : left.pos
    const rightPos = right.kind === "delete" ? right.from : right.pos
    return rightPos - leftPos
  })) {
    if (operation.kind === "delete") {
      transaction.delete(operation.from, operation.to)
    } else {
      transaction.insert(operation.pos, operation.node)
    }
  }
  return transaction
}

function createComposerEntityPlugins() {
  const entitySelectionPlugin = new Plugin({
    props: {
      decorations: getPromptInputEntitySelectionDecorations,
    },
  })
  const entityStructurePlugin = new Plugin({
    appendTransaction: normalizeComposerEntityStructure,
  })

  return [entitySelectionPlugin, entityStructurePlugin]
}

export {
  createComposerEntityPlugins,
  deleteComposerEntityBackward,
  deleteComposerEntityForward,
  getPromptInputEntitySelectionDecorations,
}
