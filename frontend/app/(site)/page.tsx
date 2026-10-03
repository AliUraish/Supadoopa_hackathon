// Landing: what Doorway is, how it works, and how to connect. No login wall.

import { Hero } from "@/components/landing/hero";
import {
  Connect,
  HowItWorks,
  LandingFooter,
  Numbers,
  PayPerCall,
  SharedMemory,
  Strategies,
} from "@/components/landing/sections";

export default function Home() {
  return (
    <main className="flex w-full flex-1 flex-col">
      <Hero />
      <HowItWorks />
      <Strategies />
      <SharedMemory />
      <PayPerCall />
      <Numbers />
      <Connect />
      <LandingFooter />
    </main>
  );
}
