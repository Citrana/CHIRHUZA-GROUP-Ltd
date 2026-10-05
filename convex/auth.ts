import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";

const password = Password({
  // Accounts are only ever created by an admin via `createAccount` in
  // convex/users.ts (see createUser action) - never through this provider's
  // own "signUp" flow. `profile()` runs for every flow but its return value
  // is only used (for its `email`) outside "signUp"; the extra fields below
  // are unused placeholders required to satisfy the return type.
  profile(params) {
    if (params.flow === "signUp") {
      throw new ConvexError(
        "Public sign-up is disabled. Ask an administrator to create your account.",
      );
    }
    return {
      email: params.email as string,
      name: "",
      roleId: null,
      status: "active",
      mustChangePassword: false,
      createdBy: null,
    };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [password],
  callbacks: {
    async beforeSessionCreation(ctx, { userId }) {
      const user = await ctx.db.get(userId);
      if (!user || user.status === "blocked") {
        throw new ConvexError("This account cannot sign in.");
      }
    },
  },
});
