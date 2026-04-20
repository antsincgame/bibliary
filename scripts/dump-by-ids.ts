import { readFileSync, writeFileSync } from "node:fs";

const targetIds = new Set<string>([
  "185ccc87-477d-5c22-aa23-d2d1c8af3486",
  "555c51ff-26fe-5428-8e4b-de36aad3af39",
  "d67ba733-a723-5cf9-a1f0-b01a50a50250",
  "e029c88d-70a0-53c5-ad3b-fa0f4e406b3a",
  "3376efeb-d4eb-5b64-8e0a-cb34f5c5f8d9",
  "661738ad-5fc8-56b2-86c8-a8974e3a850f",
  "ac50f45b-28ce-5090-b707-2208b2599762",
  "7f71683d-6d0d-544f-9dc7-e2fd3dd05cbc",
  "e2aa6783-6e3b-5b09-aa6b-4fa5e66735c1",
  "758b2895-7cbb-5404-a8c6-49c4f0879b38",
  "106e1025-9f90-560a-a0eb-16c6ae9bd330",
  "2f3f5a17-17c4-5b49-95b5-5f3127bae0e2",
  "6a526b83-ee8a-5bbf-8794-06887e334a35",
  "d88b0fb8-c85f-5d16-ae1e-98970b8bb252",
  "8081df08-d2a5-5e5b-b863-e954a07f4a1e",
  "dede3eee-2a06-5e2b-98c4-6fe230a89527",
  "4422e07b-f457-532a-849c-37635b4e50f0",
  "85d371d0-bf0a-5ded-962d-4c1cbef41d5a",
  "5cc2d275-ddad-52b3-88e2-a76069b32dd6",
  "1028349b-43f0-5822-ba83-37d5d29af1d3",
  "df1e700d-d2b1-5580-a4c3-d55a3c3b0094",
  "a66b8116-85da-512c-b52f-b3df16e99de3",
  "4c092847-2a21-5a18-aaf9-8d3f4b7f95c8",
  "f401c19a-35cb-5406-959f-1a684f7145c1",
]);

type P = { id: string; principle: string; explanation: string; domain: string; tags: string[] };
const all = JSON.parse(readFileSync("data/_export-all.json", "utf8")) as P[];

const out: P[] = [];
for (const p of all) {
  const shortId = p.id.slice(0, 8);
  for (const t of targetIds) {
    if (t.startsWith(shortId)) {
      out.push(p);
      break;
    }
  }
}

writeFileSync("data/_targets.json", JSON.stringify(out, null, 2), "utf8");
console.log(`Matched ${out.length}/${targetIds.size} targets`);
