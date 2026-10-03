import { signIn, signUp } from "./actions";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error, message, next } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="text-2xl font-semibold">Sign in</h1>

        {typeof error === "string" && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>
        )}
        {typeof message === "string" && (
          <p className="rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-700">{message}</p>
        )}

        <input type="hidden" name="next" value={typeof next === "string" ? next : ""} />
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="rounded-md border border-foreground/20 bg-transparent px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={6}
            autoComplete="current-password"
            className="rounded-md border border-foreground/20 bg-transparent px-3 py-2"
          />
        </label>

        <button
          formAction={signIn}
          className="rounded-md bg-foreground px-3 py-2 font-medium text-background"
        >
          Sign in
        </button>
        <button
          formAction={signUp}
          className="rounded-md border border-foreground/20 px-3 py-2 font-medium"
        >
          Create account
        </button>
      </form>
    </main>
  );
}
