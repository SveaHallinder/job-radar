import { Dashboard } from "./components/dashboard";
import { getJobRepository } from "@/lib/job-radar/db";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const repository = getJobRepository();
  const jobs = await repository.listJobs();
  const stats = await repository.getDashboardStats();
  const searches = await repository.listSearches();

  return <Dashboard jobs={jobs} stats={stats} searches={searches} />;
}
