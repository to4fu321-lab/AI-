import { AdminReportScreen } from "@/features/AdminReportScreen";

export default async function AdminReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AdminReportScreen id={id} />;
}
