import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText,
  ClipboardCheck,
  AlertTriangle,
  Shield,
  TrendingUp,
  TrendingDown,
  Clock,
  CheckCircle,
} from "lucide-react";
import type { Document, Audit, NonConformance, Capa } from "@shared/schema";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

function StatCard({
  title,
  value,
  icon: Icon,
  description,
  trend,
  loading,
  testId,
}: {
  title: string;
  value: string | number;
  icon: React.ElementType;
  description: string;
  trend?: "up" | "down" | "neutral";
  loading?: boolean;
  testId: string;
}) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-4" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-8 w-16 mb-1" />
          <Skeleton className="h-3 w-32" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold" data-testid={`${testId}-value`}>{value}</div>
        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
          {trend === "up" && <TrendingUp className="h-3 w-3 text-green-500" />}
          {trend === "down" && <TrendingDown className="h-3 w-3 text-red-500" />}
          {description}
        </p>
      </CardContent>
    </Card>
  );
}

const CHART_COLORS = [
  "hsl(221, 83%, 53%)",
  "hsl(210, 70%, 42%)",
  "hsl(200, 65%, 40%)",
  "hsl(190, 60%, 38%)",
  "hsl(180, 55%, 36%)",
];

export default function Dashboard() {
  const { data: documents, isLoading: docsLoading } = useQuery<Document[]>({
    queryKey: ["/api/documents"],
  });
  const { data: audits, isLoading: auditsLoading } = useQuery<Audit[]>({
    queryKey: ["/api/audits"],
  });
  const { data: ncs, isLoading: ncsLoading } = useQuery<NonConformance[]>({
    queryKey: ["/api/non-conformances"],
  });
  const { data: capas, isLoading: capasLoading } = useQuery<Capa[]>({
    queryKey: ["/api/capas"],
  });

  const loading = docsLoading || auditsLoading || ncsLoading || capasLoading;

  const openNCs = ncs?.filter((nc) => nc.status === "open").length ?? 0;
  const openCapas = capas?.filter((c) => c.status === "open").length ?? 0;
  const completedAudits = audits?.filter((a) => a.status === "completed").length ?? 0;
  const approvedDocs = documents?.filter((d) => d.status === "approved").length ?? 0;

  const ncBySeverity = ncs
    ? [
        { name: "Critical", value: ncs.filter((n) => n.severity === "critical").length },
        { name: "Major", value: ncs.filter((n) => n.severity === "major").length },
        { name: "Minor", value: ncs.filter((n) => n.severity === "minor").length },
      ]
    : [];

  const docsByCategory = documents
    ? Object.entries(
        documents.reduce<Record<string, number>>((acc, d) => {
          acc[d.category] = (acc[d.category] || 0) + 1;
          return acc;
        }, {})
      ).map(([name, count]) => ({ name, count }))
    : [];

  return (
    <div className="p-6 space-y-6 overflow-auto h-full">
      <div>
        <h1 className="text-2xl font-bold" data-testid="text-dashboard-title">Dashboard</h1>
        <p className="text-muted-foreground text-sm">Quality Management System overview</p>
      </div>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Documents"
          value={documents?.length ?? 0}
          icon={FileText}
          description={`${approvedDocs} approved`}
          trend="up"
          loading={loading}
          testId="stat-documents"
        />
        <StatCard
          title="Audits"
          value={audits?.length ?? 0}
          icon={ClipboardCheck}
          description={`${completedAudits} completed`}
          trend="up"
          loading={loading}
          testId="stat-audits"
        />
        <StatCard
          title="Open NCs"
          value={openNCs}
          icon={AlertTriangle}
          description={`${ncs?.length ?? 0} total`}
          trend={openNCs > 3 ? "down" : "up"}
          loading={loading}
          testId="stat-ncs"
        />
        <StatCard
          title="Open CAPAs"
          value={openCapas}
          icon={Shield}
          description={`${capas?.length ?? 0} total`}
          trend="neutral"
          loading={loading}
          testId="stat-capas"
        />
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Documents by Category</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[250px] w-full" />
            ) : docsByCategory.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={docsByCategory}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="name" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "6px",
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(221, 83%, 53%)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground text-sm">
                No documents yet
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Non-Conformances by Severity</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[250px] w-full" />
            ) : ncBySeverity.some((s) => s.value > 0) ? (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={ncBySeverity}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={4}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {ncBySeverity.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "6px",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[250px] flex items-center justify-center text-muted-foreground text-sm">
                No non-conformances recorded
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Non-Conformances</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : ncs && ncs.length > 0 ? (
              <div className="space-y-3">
                {ncs.slice(0, 5).map((nc) => (
                  <div
                    key={nc.id}
                    className="flex items-center justify-between gap-2 p-3 rounded-md bg-muted/50"
                    data-testid={`nc-item-${nc.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <AlertTriangle className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{nc.title}</p>
                        <p className="text-xs text-muted-foreground">{nc.ncNumber}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge
                        variant={
                          nc.severity === "critical"
                            ? "destructive"
                            : nc.severity === "major"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {nc.severity}
                      </Badge>
                      <Badge variant={nc.status === "open" ? "outline" : "secondary"}>
                        {nc.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No non-conformances recorded
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Upcoming Audits</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : audits && audits.length > 0 ? (
              <div className="space-y-3">
                {audits.slice(0, 5).map((audit) => (
                  <div
                    key={audit.id}
                    className="flex items-center justify-between gap-2 p-3 rounded-md bg-muted/50"
                    data-testid={`audit-item-${audit.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {audit.status === "completed" ? (
                        <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{audit.title}</p>
                        <p className="text-xs text-muted-foreground">{audit.department}</p>
                      </div>
                    </div>
                    <Badge variant={audit.status === "completed" ? "secondary" : "outline"}>
                      {audit.status}
                    </Badge>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No audits scheduled
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
