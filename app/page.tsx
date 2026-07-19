import { Dashboard } from "./components/dashboard";
import { getJobRepository } from "@/lib/job-radar/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const repository = getJobRepository();
  // Fetch independent reads in parallel — each is a separate Neon round trip.
  const [jobs, stats, searches] = await Promise.all([
    repository.listJobs(),
    repository.getDashboardStats(),
    repository.listSearches(),
  ]);

  return <Dashboard jobs={jobs} stats={stats} searches={searches} />;
}
