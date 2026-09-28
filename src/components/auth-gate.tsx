"use client";

import { useEffect, type ReactNode } from "react";
import { useConvexAuth, useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { usePathname, useRouter } from "@/i18n/navigation";
import { ChangePasswordScreen } from "@/components/change-password-screen";

const PUBLIC_PATHS = new Set(["/login"]);

function FullScreenSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signOut } = useAuthActions();
  const pathname = usePathname();
  const router = useRouter();
  const isPublicPath = PUBLIC_PATHS.has(pathname);

  const currentUser = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? {} : "skip",
  );

  // A session can outlive the user being blocked; getCurrentUser then
  // returns null even though isAuthenticated is still true. Sign out so
  // the normal unauthenticated redirect below takes over.
  const isBlockedSession = isAuthenticated && currentUser === null;

  useEffect(() => {
    if (isBlockedSession) {
      void signOut();
    }
  }, [isBlockedSession, signOut]);

  useEffect(() => {
    if (isLoading || isBlockedSession) {
      return;
    }
    if (!isAuthenticated && !isPublicPath) {
      router.replace("/login");
    }
    if (isAuthenticated && isPublicPath) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, isPublicPath, isBlockedSession, router]);

  if (isLoading || isBlockedSession) {
    return <FullScreenSpinner />;
  }

  if (!isAuthenticated) {
    return isPublicPath ? <>{children}</> : null;
  }

  if (isPublicPath) {
    // Redirecting away via the effect above.
    return null;
  }

  if (currentUser === undefined || currentUser === null) {
    // undefined: still loading. null: signOut() from the effect above is
    // in flight (isBlockedSession) - either way, nothing to render yet.
    return <FullScreenSpinner />;
  }

  if (currentUser.mustChangePassword) {
    return <ChangePasswordScreen />;
  }

  return <>{children}</>;
}
