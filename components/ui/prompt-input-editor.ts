import {
  createActionQueryPlugin,
  createActionQueryPublisher,
  endPromptInputActionQuery,
  readPromptInputActionQuery,
  readPromptInputActionQuerySession,
  replacePromptInputActionQuery,
  toggleSyntheticPromptInputActionQuery,
  type PromptInputActionQuery,
  type PromptInputActionQueryTrigger,
} from "@/components/ui/action-query-plugin"
import {
  createComposerEntityPlugins,
  deleteComposerEntityBackward,
  deleteComposerEntityForward,
  getPromptInputEntitySelectionDecorations,
} from "@/components/ui/composer-entity-plugin"
import {
  createPromptInputDocument,
  promptInputEntitiesEqual,
  promptInputSchema,
  readPromptInputDocument,
  readPromptInputEntities,
  replacePromptInputDocument,
  setPromptInputSelection,
  type PromptInputEntity,
} from "@/components/ui/prompt-input-schema"
import {
  baseKeymap,
  chainCommands,
  liftEmptyBlock,
  splitBlock,
} from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules"
import { keymap } from "prosemirror-keymap"
import {
  liftListItem,
  sinkListItem,
  splitListItem,
} from "prosemirror-schema-list"
import { Plugin, type EditorState } from "prosemirror-state"
import { Decoration, DecorationSet } from "prosemirror-view"
import {
  createPromptInputFormattingPlugin,
  promptInputFormattingKeymap,
} from "./prompt-input-formatting"

/**
 * The Composer editor's public surface: plugin assembly plus re-exports of the
 * three subsystems it composes —
 *   - prompt-input-schema: the document model and Markdown-string boundary
 *   - composer-entity-plugin (+ composer-entity-pill): mention-pill mechanics
 *   - action-query-plugin: discovery-session state machine
 * Consumers import from here; the split keeps each subsystem independently
 * reviewable without changing this module's API.
 */

function createPromptInputPlugins(placeholder: () => string | undefined) {
  const insertParagraph = chainCommands(
    splitListItem(promptInputSchema.nodes.list_item),
    liftEmptyBlock,
    splitBlock
  )
  const placeholderPlugin = new Plugin({
    props: {
      decorations(state: EditorState) {
        const paragraph = state.doc.firstChild
        if (
          !paragraph ||
          state.doc.childCount !== 1 ||
          paragraph.content.size !== 0
        ) {
          return null
        }

        return DecorationSet.create(state.doc, [
          Decoration.node(0, paragraph.nodeSize, {
            class: "placeholder",
            "data-empty-paragraph": "true",
            "data-placeholder": placeholder() ?? "",
          }),
        ])
      },
    },
  })

  return [
    history(),
    inputRules({
      rules: [
        textblockTypeInputRule(
          /^(#{1,3})\s$/,
          promptInputSchema.nodes.heading,
          (match) => ({ level: match[1].length })
        ),
        wrappingInputRule(
          /^\s*([-+*])\s$/,
          promptInputSchema.nodes.bullet_list
        ),
        wrappingInputRule(
          /^(\d+)\.\s$/,
          promptInputSchema.nodes.ordered_list,
          (match) => ({ order: Number(match[1]) }),
          (match, node) =>
            node.childCount + node.attrs.order === Number(match[1])
        ),
        new InputRule(/\*\*([^*]+)\*\*$/, (state, match, start, end) =>
          state.tr
            .delete(end - 1, end)
            .delete(start, start + 2)
            .addMark(start, end - 3, promptInputSchema.marks.strong.create())
            .removeStoredMark(promptInputSchema.marks.strong)
        ),
        new InputRule(/(?:^|\s)\*([^*]+)\*$/, (state, match, start, end) => {
          const from = start + (match[0].startsWith(" ") ? 1 : 0)
          return state.tr
            .delete(from, from + 1)
            .addMark(from, end - 1, promptInputSchema.marks.em.create())
            .removeStoredMark(promptInputSchema.marks.em)
        }),
      ],
    }),
    placeholderPlugin,
    ...createComposerEntityPlugins(),
    createActionQueryPlugin(),
    createPromptInputFormattingPlugin(),
    keymap({
      Backspace: chainCommands(undoInputRule, deleteComposerEntityBackward),
      Delete: deleteComposerEntityForward,
      "Mod-y": redo,
      "Mod-z": undo,
      ...promptInputFormattingKeymap,
      Enter: insertParagraph,
      "Shift-Enter": insertParagraph,
      Tab: sinkListItem(promptInputSchema.nodes.list_item),
      "Shift-Tab": liftListItem(promptInputSchema.nodes.list_item),
      "Shift-Mod-z": redo,
    }),
    keymap(baseKeymap),
  ]
}

export type {
  PromptInputActionQuery,
  PromptInputActionQueryTrigger,
  PromptInputEntity,
}

export {
  createActionQueryPublisher,
  createPromptInputDocument,
  createPromptInputPlugins,
  deleteComposerEntityBackward,
  deleteComposerEntityForward,
  endPromptInputActionQuery,
  getPromptInputEntitySelectionDecorations,
  promptInputEntitiesEqual,
  promptInputSchema,
  readPromptInputActionQuery,
  readPromptInputActionQuerySession,
  readPromptInputDocument,
  readPromptInputEntities,
  replacePromptInputActionQuery,
  replacePromptInputDocument,
  setPromptInputSelection,
  toggleSyntheticPromptInputActionQuery,
}
