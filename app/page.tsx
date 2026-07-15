import { Dashboard } from "./components/dashboard";
import { getJobRepository } from "@/lib/job-radar/db";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const repository = getJobRepository();
  const jobs = repository.listJobs();
  const stats = repository.getDashboardStats();

  return <Dashboard jobs={jobs} stats={stats} />;
}
