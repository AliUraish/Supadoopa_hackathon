"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { createClient } from "@/lib/supabase/server";

function readForm(formData: FormData) {
  return {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  };
}

export async function signIn(formData: FormData) {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(readForm(formData));
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect(safeNext(formData.get("next")));
}

export async function signUp(formData: FormData) {
  const origin = (await headers()).get("origin");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    ...readForm(formData),
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  // With "Confirm email" on, there's no session until the link is clicked.
  if (!data.session) {
    redirect(`/login?message=${encodeURIComponent("Check your email to confirm your account")}`);
  }
  redirect(safeNext(formData.get("next")));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
