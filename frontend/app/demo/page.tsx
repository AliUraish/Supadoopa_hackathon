import { getClinicVersion } from "./actions";
import { DEMO_SITE } from "./site";
import { DoorwayDemo } from "./doorway-demo";

export const metadata = { title: "Doorway · Live demo" };

export default async function DemoPage() {
  return (
    <DoorwayDemo
      doorwayUrl={process.env.NEXT_PUBLIC_DOORWAY_URL ?? ""}
      site={DEMO_SITE}
      initialClinicVersion={await getClinicVersion()}
    />
  );
}
