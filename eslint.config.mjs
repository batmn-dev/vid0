import nextConfig from "eslint-config-next"

const eslintConfig = [
  ...nextConfig,
  {
    // output/ holds local QA captures (see .gitignore); their bundles OOM ESLint.
    ignores: ["convex/_generated/**", ".next-perf/**", "output/**"],
  },
  {
    // Icon system enforcement: use Remix Icons React components for UI icons.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react",
              message: "Use @remixicon/react for UI icons.",
            },
            {
              name: "@phosphor-icons/react",
              message: "Use @remixicon/react for UI icons.",
            },
            {
              name: "remixicon-react",
              message: "Use the official @remixicon/react package instead.",
            },
            {
              name: "remixicon",
              message:
                "Use @remixicon/react components, not the CSS/webfont package.",
            },
          ],
          patterns: [
            {
              group: ["lucide-react/*"],
              message: "Use @remixicon/react for UI icons.",
            },
            {
              group: ["@phosphor-icons/react/*"],
              message: "Use @remixicon/react for UI icons.",
            },
          ],
        },
      ],
    },
  },
  {
    // Prefer `type` over `interface` for type definitions (R09).
    // Reasons: consistency across the codebase, better union/intersection composability,
    // and alignment with React 19 patterns (e.g. props as type aliases).
    // Existing violations should be fixed opportunistically during other work.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
    },
  },
  {
    // Authenticated handler seam (ADR-0003): Convex handlers must go through the
    // builders in convex/lib/authedFunctions.ts (which inject ctx.user / ctx.chat
    // / ctx.identity) instead of calling ctx.auth.getUserIdentity() inline. This
    // keeps auth structural and un-bypassable. The auth helpers themselves live
    // in convex/lib/ and are exempt below.
    files: ["convex/**/*.ts"],
    ignores: ["convex/lib/**", "convex/**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='getUserIdentity'][callee.object.property.name='auth']",
          message:
            "Do not call ctx.auth.getUserIdentity() directly. Use the builders in convex/lib/authedFunctions.ts (authenticatedQuery/Mutation, ownedChatMutation, maybeAuth*, optionalAuth*, identity*) so auth is structural. See ADR-0003.",
        },
      ],
    },
  },
  {
    // Per-user subscription seam (ADR-0004): client per-user Convex live reads
    // must go through usePerUserQuery in lib/convex/, which owns the
    // isConvexAuthenticated subscribe gate. Importing useQuery from convex/react
    // directly bypasses the gate — which is how userKeys.getProviderStatus ended
    // up ungated and running for guests. The hook module in lib/convex/ is the
    // one exempt place; add a named public seam there only with a real caller.
    files: [
      "app/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
    ],
    ignores: ["lib/convex/use-per-user-query.ts", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value=/^convex\\/react$|^convex-helpers\\/react\\/cache/] > ImportSpecifier[imported.name='useQuery']",
          message:
            "Do not import useQuery from convex/react or convex-helpers/react/cache directly. Use usePerUserQuery from @/lib/convex/use-per-user-query, which owns the isConvexAuthenticated subscribe gate and the warm query cache. Add a named public seam there only with a real caller. See ADR-0004 and ADR-0031.",
        },
        {
          selector:
            "ImportDeclaration[source.value='convex/react'] > ImportSpecifier[imported.name='usePaginatedQuery']",
          message:
            "Do not import usePaginatedQuery from convex/react directly. Use usePerUserPaginatedQuery from @/lib/convex/use-per-user-query, which owns the isConvexAuthenticated subscribe gate. See ADR-0004.",
        },
      ],
    },
  },
]

export default eslintConfig
