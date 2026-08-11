import { redirect } from "next/navigation";

/** /proof retired — replaced by the customer-facing personhood explainer. */
export default function ProofRedirect() {
  redirect("/personhood");
}
