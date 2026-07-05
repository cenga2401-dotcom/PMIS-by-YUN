class ESGStorage {
  /** Creates a LocalStorage wrapper with a fixed storage key. */
  constructor(key) {
    this.key = key;
    this.configKey = `${key}.supabaseConfig`;
  }

  /** Reads persisted application data from LocalStorage. */
  load() {
    const raw = localStorage.getItem(this.key);
    return raw ? JSON.parse(raw) : null;
  }

  /** Writes application data to LocalStorage. */
  save(data) {
    localStorage.setItem(this.key, JSON.stringify(data));
  }

  /** Reads Supabase connection settings from LocalStorage or window config. */
  loadConfig() {
    const saved = localStorage.getItem(this.configKey);
    const local = saved ? JSON.parse(saved) : {};
    const global = window.PMIS_SUPABASE_CONFIG || {};
    return {
      url: (local.url || global.url || "").trim(),
      anonKey: (local.anonKey || global.anonKey || "").trim()
    };
  }

  /** Saves Supabase connection settings locally. */
  saveConfig(config) {
    localStorage.setItem(this.configKey, JSON.stringify(config));
  }

  /** Clears Supabase connection settings. */
  clearConfig() {
    localStorage.removeItem(this.configKey);
  }
}

class SupabasePMISStore {
  /** Creates a small Supabase REST client without external packages. */
  constructor(config) {
    this.url = config.url.replace(/\/$/, "");
    this.anonKey = config.anonKey;
    this.tables = ["projects", "tasks", "milestones", "notes", "attachments", "activityLogs"];
    this.knownRowIds = this.emptyTableSets();
    this.knownPayloads = this.emptyTableMaps();
    this.remoteLoaded = false;
  }

  /** Returns whether Supabase is configured enough to use. */
  isConfigured() {
    return Boolean(this.url && this.anonKey);
  }

  /** Calls the Supabase REST API. */
  async request(path, options = {}) {
    const response = await fetch(`${this.url}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Supabase request failed: ${response.status}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  /** Loads all PMIS tables and reconstructs the app state. */
  async loadData(fallbackData) {
    if (!this.isConfigured()) return fallbackData;
    const [projectRows, taskRows, milestoneRows, noteRows, attachmentRows, activityRows] = await Promise.all([
      this.readTable("projects"),
      this.readTable("tasks"),
      this.readTable("milestones"),
      this.readTable("notes"),
      this.readTable("attachments"),
      this.readTable("activityLogs")
    ]);
    const rowsByTable = {
      projects: projectRows,
      tasks: taskRows,
      milestones: milestoneRows,
      notes: noteRows,
      attachments: attachmentRows,
      activityLogs: activityRows
    };
    this.rememberRemoteRows(rowsByTable);
    this.remoteLoaded = true;
    if (!this.hasAnyRows(rowsByTable)) {
      return { ...fallbackData, projects: [], tasks: [] };
    }
    const projects = projectRows
      .filter(row => !row.project_id)
      .map(row => ({ ...row.payload, id: row.id }))
      .sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
    projects.forEach(project => {
      project.tasks = taskRows.filter(row => row.project_id === project.id).map(row => ({ ...row.payload, id: row.id }));
      project.checklist = milestoneRows.filter(row => row.project_id === project.id).map(row => ({ ...row.payload, id: row.id }));
      project.notes = noteRows.filter(row => row.project_id === project.id).map(row => ({ ...row.payload, id: row.id }));
      project.attachments = attachmentRows.filter(row => row.project_id === project.id).map(row => ({ ...row.payload, id: row.id }));
      project.activityLogs = activityRows.filter(row => row.project_id === project.id).map(row => ({ ...row.payload, id: row.id }));
    });
    return {
      ...fallbackData,
      projects,
      tasks: taskRows.filter(row => !row.project_id).map(row => ({ ...row.payload, id: row.id }))
    };
  }

  /** Reads one Supabase table. */
  async readTable(table) {
    return await this.request(`${table}?select=id,project_id,payload,updated_at`) || [];
  }

  /** Upserts changed PMIS rows without clearing unrelated remote data. */
  async saveData(data) {
    if (!this.isConfigured()) return;
    if (!this.remoteLoaded) {
      await this.loadData({ theme: "light", statuses: [], projects: [], tasks: [] });
    }
    const rows = this.flattenData(data);
    for (const table of this.tables) {
      const changedRows = rows[table].filter(row => this.rowNeedsUpsert(table, row));
      if (changedRows.length) await this.upsertRows(table, changedRows);
      changedRows.forEach(row => this.rememberRow(table, row));
    }
    for (const table of [...this.tables].reverse()) {
      const desiredIds = new Set(rows[table].map(row => row.id));
      const deletedIds = [...this.knownRowIds[table]].filter(id => !desiredIds.has(id));
      if (deletedIds.length) await this.deleteRows(table, deletedIds);
      deletedIds.forEach(id => {
        this.knownRowIds[table].delete(id);
        this.knownPayloads[table].delete(id);
      });
    }
  }

  /** Imports existing LocalStorage data into Supabase. */
  async migrateFromLocalStorage(data) {
    await this.clearAllTables();
    this.knownRowIds = this.emptyTableSets();
    this.knownPayloads = this.emptyTableMaps();
    this.remoteLoaded = true;
    const rows = this.flattenData(data);
    for (const table of this.tables) {
      if (rows[table].length) await this.upsertRows(table, rows[table]);
      rows[table].forEach(row => this.rememberRow(table, row));
    }
  }

  /** Deletes all app rows from PMIS tables. */
  async clearAllTables() {
    for (const table of [...this.tables].reverse()) {
      await this.request(`${table}?id=neq.__pmis_never__`, { method: "DELETE" });
    }
  }

  /** Upserts rows into a Supabase table. */
  async upsertRows(table, rows) {
    await this.request(`${table}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows)
    });
  }

  /** Deletes specific Supabase rows by id only when the local user deleted them. */
  async deleteRows(table, ids) {
    for (const id of ids) {
      await this.request(`${table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
    }
  }

  /** Creates an empty set collection keyed by table name. */
  emptyTableSets() {
    return Object.fromEntries(this.tables.map(table => [table, new Set()]));
  }

  /** Creates an empty payload map collection keyed by table name. */
  emptyTableMaps() {
    return Object.fromEntries(this.tables.map(table => [table, new Map()]));
  }

  /** Remembers the latest remote rows so future saves only send real changes. */
  rememberRemoteRows(rowsByTable) {
    this.knownRowIds = this.emptyTableSets();
    this.knownPayloads = this.emptyTableMaps();
    this.tables.forEach(table => {
      rowsByTable[table].forEach(row => this.rememberRow(table, row));
    });
  }

  /** Remembers one known remote row payload. */
  rememberRow(table, row) {
    this.knownRowIds[table].add(row.id);
    this.knownPayloads[table].set(row.id, this.stablePayload(row.payload));
  }

  /** Returns true when any Supabase table has data. */
  hasAnyRows(rowsByTable) {
    return this.tables.some(table => rowsByTable[table].length > 0);
  }

  /** Returns whether a row is new or changed compared with the last remote snapshot. */
  rowNeedsUpsert(table, row) {
    return this.knownPayloads[table].get(row.id) !== this.stablePayload(row.payload);
  }

  /** Stringifies payloads consistently for lightweight change detection. */
  stablePayload(payload) {
    return JSON.stringify(payload || {});
  }

  /** Converts current nested app data into Supabase table rows. */
  flattenData(data) {
    const now = new Date().toISOString();
    const rows = {
      projects: [],
      tasks: [],
      milestones: [],
      notes: [],
      attachments: [],
      activityLogs: []
    };
    data.projects.forEach(project => {
      const { tasks = [], checklist = [], notes = [], attachments = [], activityLogs = [], ...projectPayload } = project;
      rows.projects.push(this.row(project.id, null, projectPayload, now));
      tasks.forEach(task => rows.tasks.push(this.row(task.id, project.id, task, now)));
      checklist.forEach(milestone => rows.milestones.push(this.row(milestone.id, project.id, milestone, now)));
      notes.forEach(note => rows.notes.push(this.row(note.id, project.id, note, now)));
      attachments.forEach(file => rows.attachments.push(this.row(file.id, project.id, file, now)));
      activityLogs.forEach(log => rows.activityLogs.push(this.row(log.id, project.id, log, now)));
    });
    data.tasks.forEach(task => rows.tasks.push(this.row(task.id, null, task, now)));
    return rows;
  }

  /** Creates one normalized Supabase row. */
  row(id, projectId, payload, updatedAt) {
    return {
      id,
      project_id: projectId,
      payload,
      updated_at: updatedAt
    };
  }
}

class ESGApp {
  /** Creates the main application controller and initializes state defaults. */
  constructor() {
    this.storage = new ESGStorage("esgIsoConsultingApp.v1");
    const storedData = this.storage.load();
    this.localMigrationSnapshot = storedData ? JSON.parse(JSON.stringify(storedData)) : null;
    this.supabaseConfig = this.storage.loadConfig();
    this.supabaseStore = new SupabasePMISStore(this.supabaseConfig);
    this.supabaseEnabled = this.supabaseStore.isConfigured();
    this.syncingToSupabase = false;
    this.syncingFromSupabase = false;
    this.pendingSupabaseSync = false;
    this.supabasePollTimer = null;
    this.syncStatus = this.supabaseEnabled ? "同步中" : "使用本機模式";
    this.projectTypes = ["ISO14064", "ISO14067", "ISO50001", "ISO14001", "CBAM", "PCR", "碳標籤", "ESG", "政府補助", "其他"];
    this.defaultStatuses = [
      { id: "待報價", name: "待報價", color: "#64748b", locked: false },
      { id: "In Progress", name: "進行中", color: "#2563eb", locked: false },
      { id: "Waiting Customer", name: "等待客戶", color: "#f59e0b", locked: false },
      { id: "待查驗", name: "待查驗", color: "#7c3aed", locked: false },
      { id: "Completed", name: "Completed", color: "#16a34a", locked: true }
    ];
    this.legacyStatusNames = { "In Progress": "進行中", "Waiting Customer": "等待客戶", Reviewing: "查驗中", Completed: "Completed" };
    this.statusPalette = ["#64748b", "#2563eb", "#f59e0b", "#7c3aed", "#16a34a", "#0891b2", "#db2777", "#0f766e", "#ea580c"];
    this.checklistTemplates = {
      ISO14064: ["報價", "合約", "Kickoff", "收活動數據", "現場盤查", "排放量計算", "初稿", "客戶確認", "查驗", "結案"],
      ISO14067: ["BOM", "製程流程", "LCA建模", "碳足跡計算", "初稿", "修正", "查驗", "碳標籤", "結案"],
      ISO50001: ["能源審查", "EnPI", "Baseline", "改善方案", "文件建立", "內部稽核", "管理審查", "驗證", "結案"]
    };
    this.milestoneTemplate = ["客戶立案", "請頭款", "頭款已收", "執行專案", "請尾款", "尾款已收", "結案"];
    this.state = this.migrate(storedData || this.createDemoData());
    this.activeView = "dashboard";
    this.projectTab = "active";
    this.calendarDate = new Date();
    this.calendarMode = "month";
    this.calendarDetailCollapsed = false;
    this.calendarPopoverDate = "";
    this.selectedCalendarProjectId = null;
    this.quickActivityExpanded = false;
    this.selectedDate = this.toDateInput(new Date());
    this.selectedProjectId = null;
    this.detailTab = "tasks";
    this.detailCollapsed = false;
    this.detailPinned = false;
    this.sort = { key: "dueDate", direction: "asc" };
    this.quickFilter = null;
    this.confirmResolver = null;
    this.saveToastTimer = null;
  }

  /** Starts the application and renders every visible area. */
  init() {
    this.cacheDom();
    this.populateSelects();
    this.bindEvents();
    this.renderAll();
    const startup = this.supabaseEnabled
      ? this.syncFromSupabase({ force: true, showToast: true })
      : Promise.resolve(this.setSyncStatus("使用本機模式", true));
    startup.finally(() => {
      this.importFinanceRowsFromExcel();
      this.startSupabasePolling();
      setTimeout(() => this.dom.loading.classList.add("hidden"), 350);
    });
  }

  /** Stores frequently used DOM nodes for faster access. */
  cacheDom() {
    this.dom = {
      loading: document.getElementById("loading"),
      appShell: document.querySelector(".app-shell"),
      sidebar: document.querySelector(".sidebar"),
      main: document.querySelector(".main"),
      databaseSettingsBtn: document.getElementById("databaseSettingsBtn"),
      databaseModal: document.getElementById("databaseModal"),
      databaseForm: document.getElementById("databaseForm"),
      supabaseUrlInput: document.getElementById("supabaseUrlInput"),
      supabaseAnonKeyInput: document.getElementById("supabaseAnonKeyInput"),
      clearDatabaseSettingsBtn: document.getElementById("clearDatabaseSettingsBtn"),
      migrateToSupabaseBtn: document.getElementById("migrateToSupabaseBtn"),
      navLinks: document.querySelectorAll(".nav-link"),
      views: document.querySelectorAll(".view"),
      pageTitle: document.getElementById("pageTitle"),
      pageSubtitle: document.getElementById("pageSubtitle"),
      metricGrid: document.getElementById("metricGrid"),
      dashboardSearch: document.getElementById("dashboardSearch"),
      dashboardSearchResults: document.getElementById("dashboardSearchResults"),
      calendarLayout: document.querySelector(".calendar-layout"),
      calendarGrid: document.getElementById("calendarGrid"),
      calendarTitle: document.getElementById("calendarTitle"),
      calendarDetailToggle: document.getElementById("calendarDetailToggle"),
      selectedDateTitle: document.getElementById("selectedDateTitle"),
      selectedDateProjects: document.getElementById("selectedDateProjects"),
      taskForm: document.getElementById("taskForm"),
      taskInput: document.getElementById("taskInput"),
      taskList: document.getElementById("taskList"),
      projectTableHead: document.getElementById("projectTableHead"),
      projectTableBody: document.getElementById("projectTableBody"),
      fullProjectContent: document.getElementById("fullProjectContent"),
      projectListHint: document.getElementById("projectListHint"),
      activeProjectsTab: document.getElementById("activeProjectsTab"),
      historyProjectsTab: document.getElementById("historyProjectsTab"),
      projectSearch: document.getElementById("projectSearch"),
      statusFilter: document.getElementById("statusFilter"),
      typeFilter: document.getElementById("typeFilter"),
      ownerFilter: document.getElementById("ownerFilter"),
      clientFilter: document.getElementById("clientFilter"),
      startFromFilter: document.getElementById("startFromFilter"),
      startToFilter: document.getElementById("startToFilter"),
      dueFromFilter: document.getElementById("dueFromFilter"),
      dueToFilter: document.getElementById("dueToFilter"),
      sortKeySelect: document.getElementById("sortKeySelect"),
      sortDirectionSelect: document.getElementById("sortDirectionSelect"),
      clearFiltersBtn: document.getElementById("clearFiltersBtn"),
      statusForm: document.getElementById("statusForm"),
      statusNameInput: document.getElementById("statusNameInput"),
      statusList: document.getElementById("statusList"),
      projectModal: document.getElementById("projectModal"),
      projectForm: document.getElementById("projectForm"),
      projectTypeSelect: document.getElementById("projectTypeSelect"),
      projectDetail: document.getElementById("projectDetail"),
      drawerPanel: document.querySelector(".drawer-panel"),
      detailCode: document.getElementById("detailCode"),
      detailName: document.getElementById("detailName"),
      detailType: document.getElementById("detailType"),
      detailStatus: document.getElementById("detailStatus"),
      detailCollapseBtn: document.getElementById("detailCollapseBtn"),
      detailPinBtn: document.getElementById("detailPinBtn"),
      detailContent: document.getElementById("detailContent"),
      toastHost: document.getElementById("toastHost"),
      confirmDialog: document.getElementById("confirmDialog"),
      confirmTitle: document.getElementById("confirmTitle"),
      confirmMessage: document.getElementById("confirmMessage"),
      confirmOk: document.getElementById("confirmOk"),
      confirmCancel: document.getElementById("confirmCancel")
    };
  }

  /** Adds missing fields to older LocalStorage data without deleting user records. */
  migrate(data) {
    data.projects = Array.isArray(data.projects) ? data.projects : [];
    data.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    data.theme = data.theme || "light";
    data.statuses = Array.isArray(data.statuses) ? data.statuses : this.defaultStatuses.map(status => ({ ...status }));
    this.defaultStatuses.forEach(status => {
      if (!data.statuses.some(item => item.id === status.id)) data.statuses.push({ ...status });
    });
    data.projects.forEach((project, index) => {
      project.id = project.id || this.uid();
      project.code = project.code || `P-${new Date().getFullYear()}-${String(index + 1).padStart(3, "0")}`;
      project.status = project.status || "In Progress";
      project.progress = Number.isFinite(project.progress) ? project.progress : 0;
      project.completedDate = project.completedDate || "";
      project.totalAmount = this.toNumber(project.totalAmount);
      project.receivedAmount = this.toNumber(project.receivedAmount);
      project.unreceivedAmount = project.unreceivedAmount === undefined || project.unreceivedAmount === null
        ? Math.max(project.totalAmount - project.receivedAmount, 0)
        : this.toNumber(project.unreceivedAmount);
      project.paymentProgress = project.paymentProgress || "";
      project.contractPeriod = project.contractPeriod || "";
      project.checklist = Array.isArray(project.checklist) ? project.checklist : [];
      project.tasks = Array.isArray(project.tasks) ? project.tasks : [];
      project.activities = Array.isArray(project.activities) ? project.activities : [];
      if (!Array.isArray(project.activityLogs)) {
        project.activityLogs = [];
        project.activities.forEach(activity => {
          project.activityLogs.push(this.createActivityLog(
            project,
            "legacy_activity_imported",
            activity.action || "匯入既有紀錄",
            activity.content || "舊活動紀錄匯入系統",
            {},
            activity.date || project.startDate || this.today(),
            activity.time || "00:00"
          ));
        });
        if (!project.activityLogs.length) {
          project.activityLogs.push(this.createActivityLog(project, "legacy_project_imported", "匯入既有案件", "舊資料匯入系統", {}, project.startDate || this.today()));
        }
      }
      project.notes = Array.isArray(project.notes) ? project.notes : [];
      project.attachments = Array.isArray(project.attachments) ? project.attachments : [];
      project.timeline = Array.isArray(project.timeline) ? project.timeline : [];
      if (!data.statuses.some(status => status.id === project.status)) {
        data.statuses.push({
          id: project.status,
          name: this.legacyStatusNames[project.status] || project.status,
          color: this.colorForStatus(this.legacyStatusNames[project.status] || project.status, data.statuses.length),
          locked: false
        });
      }
    });
    data.statuses.forEach((status, index) => {
      status.color = this.colorForStatus(status.name || status.id, index, status.color);
    });
    return data;
  }

  /** Returns a predictable badge color for known status names. */
  colorForStatus(name, index = 0, fallback = "") {
    const normalized = String(name || "");
    if (normalized.includes("待報價")) return "#64748b";
    if (normalized.includes("進行中") || normalized === "In Progress") return "#2563eb";
    if (normalized.includes("等待客戶") || normalized === "Waiting Customer") return "#f59e0b";
    if (normalized.includes("待查驗") || normalized.includes("查驗")) return "#7c3aed";
    if (normalized.includes("Completed") || normalized.includes("已完成") || normalized.includes("結案")) return "#16a34a";
    return fallback || this.statusPalette[index % this.statusPalette.length];
  }

  /** Fills project type and status selectors with current values. */
  populateSelects() {
    const selectedType = this.dom.typeFilter?.value || "all";
    this.dom.projectTypeSelect.innerHTML = "";
    this.dom.typeFilter.innerHTML = `<option value="all">全部類型</option>`;
    this.projectTypes.forEach(type => {
      this.dom.projectTypeSelect.add(new Option(type, type));
      this.dom.typeFilter.add(new Option(type, type));
    });
    this.dom.typeFilter.value = this.projectTypes.includes(selectedType) ? selectedType : "all";
    this.dom.sortKeySelect.value = this.sort.key;
    this.dom.sortDirectionSelect.value = this.sort.direction;
    this.renderStatusOptions();
    this.renderOwnerOptions();
    this.updateSortDirectionLabels();
  }

  /** Renders status filter options from the custom status catalog. */
  renderStatusOptions() {
    const selectedStatus = this.dom.statusFilter?.value || "all";
    this.dom.statusFilter.innerHTML = `<option value="all">全部狀態</option>`;
    this.state.statuses.forEach(status => this.dom.statusFilter.add(new Option(status.name, status.id)));
    this.dom.statusFilter.value = this.state.statuses.some(status => status.id === selectedStatus) ? selectedStatus : "all";
  }

  /** Renders owner filter options from existing projects. */
  renderOwnerOptions() {
    const current = this.dom.ownerFilter.value || "all";
    const owners = [...new Set(this.state.projects.map(project => project.owner).filter(Boolean))].sort();
    this.dom.ownerFilter.innerHTML = `<option value="all">全部負責人</option>`;
    owners.forEach(owner => this.dom.ownerFilter.add(new Option(owner, owner)));
    this.dom.ownerFilter.value = owners.includes(current) ? current : "all";
  }

  /** Attaches all UI event listeners. */
  bindEvents() {
    this.dom.navLinks.forEach(button => button.addEventListener("click", () => this.switchView(button.dataset.view)));
    document.getElementById("menuToggle").addEventListener("click", () => this.dom.sidebar.classList.toggle("open"));
    this.dom.databaseSettingsBtn.addEventListener("click", () => this.openDatabaseSettings());
    document.querySelectorAll("[data-close-database-modal]").forEach(button => button.addEventListener("click", () => this.dom.databaseModal.close()));
    this.dom.databaseForm.addEventListener("submit", event => this.saveDatabaseSettings(event));
    this.dom.clearDatabaseSettingsBtn.addEventListener("click", () => this.clearDatabaseSettings());
    this.dom.migrateToSupabaseBtn.addEventListener("click", () => this.migrateLocalDataToSupabase());
    document.getElementById("themeToggle").addEventListener("click", () => this.toggleTheme());
    document.getElementById("newProjectBtn").addEventListener("click", () => this.openProjectModal());
    document.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", () => this.dom.projectModal.close()));
    document.querySelectorAll("[data-close-detail]").forEach(button => button.addEventListener("click", () => this.closeProjectDetail()));
    this.dom.detailCollapseBtn.addEventListener("click", () => this.toggleDetailCollapse());
    this.dom.detailPinBtn.addEventListener("click", () => this.toggleDetailPin());
    document.getElementById("prevPeriod").addEventListener("click", () => this.moveCalendar(-1));
    document.getElementById("nextPeriod").addEventListener("click", () => this.moveCalendar(1));
    document.getElementById("monthMode").addEventListener("click", () => this.setCalendarMode("month"));
    document.getElementById("weekMode").addEventListener("click", () => this.setCalendarMode("week"));
    this.dom.calendarDetailToggle.addEventListener("click", () => this.toggleCalendarDetail());
    this.dom.taskForm.addEventListener("submit", event => this.addTodayTask(event));
    this.dom.projectForm.addEventListener("submit", event => this.createProject(event));
    this.dom.dashboardSearch.addEventListener("input", () => this.renderDashboardSearch());
    this.dom.activeProjectsTab.addEventListener("click", () => this.setProjectTab("active"));
    this.dom.historyProjectsTab.addEventListener("click", () => this.setProjectTab("history"));
    [this.dom.projectSearch, this.dom.statusFilter, this.dom.typeFilter, this.dom.ownerFilter, this.dom.clientFilter, this.dom.startFromFilter, this.dom.startToFilter, this.dom.dueFromFilter, this.dom.dueToFilter].forEach(input => {
      input.addEventListener("input", () => this.renderProjectTable());
      input.addEventListener("change", () => this.renderProjectTable());
    });
    this.dom.sortKeySelect.addEventListener("change", () => this.changeSortFromSelects());
    this.dom.sortDirectionSelect.addEventListener("change", () => this.changeSortFromSelects());
    this.dom.clearFiltersBtn.addEventListener("click", () => this.clearFilters());
    this.dom.statusForm.addEventListener("submit", event => this.addStatus(event));
    this.dom.projectTableHead.addEventListener("click", event => {
      const th = event.target.closest("[data-sort]");
      if (th) this.changeSort(th.dataset.sort);
    });
    this.dom.confirmOk.addEventListener("click", () => this.resolveConfirm(true));
    this.dom.confirmCancel.addEventListener("click", () => this.resolveConfirm(false));
  }

  /** Creates initial demo data when the app is opened for the first time. */
  createDemoData() {
    const today = new Date();
    const addDays = days => {
      const date = new Date(today);
      date.setDate(date.getDate() + days);
      return this.toDateInput(date);
    };
    return {
      theme: "light",
      statuses: this.defaultStatuses.map(status => ({ ...status })),
      tasks: [
        { id: this.uid(), title: "追蹤 A 公司 ISO14064 活動數據", done: false },
        { id: this.uid(), title: "整理 B 公司查驗問題回覆", done: true },
        { id: this.uid(), title: "安排 ESG 顧問會議", done: false }
      ],
      projects: [
        this.demoProject("P-2026-001", "宏遠製造", "2026 組織型溫室氣體盤查", "ISO14064", addDays(-10), addDays(20), "In Progress", 45, "林顧問"),
        this.demoProject("P-2026-002", "晨星食品", "產品碳足跡與碳標籤", "ISO14067", addDays(-18), addDays(35), "Waiting Customer", 30, "王顧問"),
        this.demoProject("P-2026-003", "青川科技", "能源管理系統建置", "ISO50001", addDays(-30), addDays(55), "In Progress", 72, "陳顧問"),
        this.demoProject("P-2026-004", "海曜材料", "ESG 報告書輔導", "ESG", addDays(-60), addDays(-5), "Completed", 100, "張顧問"),
        this.demoProject("P-2026-005", "承新工業", "CBAM 申報準備", "CBAM", this.toDateInput(today), addDays(6), "In Progress", 18, "林顧問")
      ]
    };
  }

  /** Builds one demo project with related tasks, notes, attachments, and timeline. */
  demoProject(code, client, name, type, startDate, dueDate, status, progress, owner) {
    const template = this.milestoneTemplate;
    const doneCount = Math.round(template.length * progress / 100);
    return {
      id: this.uid(),
      code,
      client,
      name,
      type,
      contact: "李經理",
      phone: "02-2345-6789",
      email: "client@example.com",
      owner,
      startDate,
      dueDate,
      status,
      progress,
      completedDate: status === "Completed" ? dueDate : "",
      totalAmount: 0,
      receivedAmount: 0,
      unreceivedAmount: 0,
      paymentProgress: "",
      contractPeriod: "",
      checklist: template.map((title, index) => ({ id: this.uid(), title, done: index < doneCount })),
      tasks: [
        { id: this.uid(), title: "修改報告", done: false },
        { id: this.uid(), title: "客戶確認", done: false },
        { id: this.uid(), title: "安排查驗", done: false }
      ],
      notes: [{ id: this.uid(), date: this.toDateInput(new Date()), time: "09:30", text: "今天收到天然氣資料" }],
      attachments: [{ id: this.uid(), name: "資料清單", description: "客戶需提供文件", link: "https://example.com" }],
      timeline: ["建立案件", "Kickoff", "第一次輔導", "收資料", "初稿", "查驗", "結案"].map((title, index) => ({
        id: this.uid(),
        title,
        date: index === 0 ? startDate : "",
        done: index < Math.max(1, Math.round(progress / 18))
      }))
    };
  }

  /** Persists the current state and optionally shows an auto-save toast. */
  save(showToast = true) {
    this.storage.save(this.state);
    if (!this.supabaseEnabled) this.localMigrationSnapshot = JSON.parse(JSON.stringify(this.state));
    this.queueSupabaseSync();
    if (showToast) this.autoSaveToast();
  }

  /** Loads the latest Supabase data and keeps LocalStorage as a cache only. */
  async loadFromSupabaseIfConfigured() {
    return this.syncFromSupabase({ force: true, showToast: true });
  }

  /** Pulls the latest cloud data without overwriting an actively edited form. */
  async syncFromSupabase(options = {}) {
    const { force = false, showToast = false } = options;
    if (!this.supabaseEnabled) {
      this.setSyncStatus("使用本機模式", showToast);
      return;
    }
    if (this.syncingFromSupabase || this.syncingToSupabase) return;
    if (!force && this.supabaseSyncTimer) return;
    if (!force && this.isEditingForm()) return;
    try {
      this.syncingFromSupabase = true;
      this.setSyncStatus("同步中", showToast);
      const remote = await this.supabaseStore.loadData(this.state);
      this.state = this.migrate(remote);
      this.storage.save(this.state);
      this.renderAll();
      this.setSyncStatus("已同步", showToast);
    } catch (error) {
      console.warn(error);
      this.setSyncStatus("同步失敗", true);
    } finally {
      this.syncingFromSupabase = false;
      if (this.pendingSupabaseSync) {
        this.pendingSupabaseSync = false;
        this.queueSupabaseSync();
      }
    }
  }

  /** Starts simple polling so other users' updates appear without a refresh. */
  startSupabasePolling() {
    clearInterval(this.supabasePollTimer);
    if (!this.supabaseEnabled) {
      this.setSyncStatus("使用本機模式", false);
      return;
    }
    this.supabasePollTimer = setInterval(() => {
      this.syncFromSupabase({ force: false, showToast: false });
    }, 10000);
  }

  /** Returns true when a user is currently typing or editing a form field. */
  isEditingForm() {
    if (document.querySelector("dialog[open]")) return true;
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(tag) || active.isContentEditable;
    return editable && Boolean(active.closest("form"));
  }

  /** Records the current sync status and optionally shows it as a toast. */
  setSyncStatus(status, showToast = false) {
    this.syncStatus = status;
    if (showToast) this.toast(status);
  }

  /** Imports Excel-generated finance rows once and merges them by project code. */
  importFinanceRowsFromExcel() {
    const rows = window.PMIS_FINANCE_IMPORT;
    if (!Array.isArray(rows) || !rows.length) return;
    const version = window.PMIS_FINANCE_IMPORT_VERSION || `finance-${rows.length}`;
    const flagKey = `${this.storage.key}.financeImport.${version}`;
    if (localStorage.getItem(flagKey)) return;
    let created = 0;
    let updated = 0;
    rows.forEach(row => {
      const code = String(row.code || "").trim();
      if (!code) return;
      const project = this.state.projects.find(item => String(item.code || "").trim().toLowerCase() === code.toLowerCase());
      if (project) {
        this.mergeFinanceRowIntoProject(project, row);
        this.addActivityLog(project, "project_updated", "匯入財務資料", "由 Excel 匯入專案總額、已收金額、未收金額", { source: "excel_finance_import" });
        updated += 1;
        return;
      }
      const importedProject = this.createProjectFromFinanceRow(row);
      this.addActivityLog(importedProject, "project_created", "建立案件", `由 Excel 匯入案件：「${importedProject.name}」`, { source: "excel_finance_import" });
      this.state.projects.push(importedProject);
      created += 1;
    });
    localStorage.setItem(flagKey, "1");
    if (created || updated) {
      this.state = this.migrate(this.state);
      this.save(false);
      this.renderAll();
      this.toast(`已匯入 Excel 金額資料：新增 ${created} 筆，更新 ${updated} 筆`);
    }
  }

  /** Applies one imported finance row to an existing project without deleting user edits. */
  mergeFinanceRowIntoProject(project, row) {
    project.totalAmount = this.toNumber(row.totalAmount);
    project.receivedAmount = this.toNumber(row.receivedAmount);
    project.unreceivedAmount = this.toNumber(row.unreceivedAmount);
    project.paymentProgress = row.paymentProgress || project.paymentProgress || "";
    project.contractPeriod = row.contractPeriod || project.contractPeriod || "";
    if (!project.client && row.client) project.client = row.client;
    if (!project.name && row.name) project.name = row.name;
    if (!project.type && row.type) project.type = row.type;
    if (!project.owner && row.owner) project.owner = row.owner;
    if (!project.startDate && row.startDate) project.startDate = row.startDate;
    if (!project.dueDate && row.dueDate) project.dueDate = row.dueDate;
  }

  /** Creates a LocalStorage-compatible project from one imported finance row. */
  createProjectFromFinanceRow(row) {
    return {
      id: this.uid(),
      code: String(row.code || "").trim(),
      client: row.client || "",
      name: row.name || row.code || "未命名案件",
      type: row.type || "其他",
      contact: "",
      phone: "",
      email: "",
      owner: row.owner || "",
      startDate: row.startDate || this.today(),
      dueDate: row.dueDate || row.startDate || this.today(),
      status: "In Progress",
      progress: 0,
      completedDate: "",
      totalAmount: this.toNumber(row.totalAmount),
      receivedAmount: this.toNumber(row.receivedAmount),
      unreceivedAmount: this.toNumber(row.unreceivedAmount),
      paymentProgress: row.paymentProgress || "",
      contractPeriod: row.contractPeriod || "",
      checklist: this.milestoneTemplate.map(title => ({ id: this.uid(), title, done: false })),
      tasks: [],
      activityLogs: [],
      notes: row.note ? [{ id: this.uid(), date: this.today(), time: new Date().toTimeString().slice(0, 5), text: row.note }] : [],
      attachments: [],
      timeline: [{ id: this.uid(), title: "建立案件", date: row.startDate || this.today(), done: true }]
    };
  }

  /** Debounces full-state Supabase synchronization. */
  queueSupabaseSync() {
    if (!this.supabaseEnabled) {
      this.setSyncStatus("使用本機模式", false);
      return;
    }
    if (this.syncingToSupabase || this.syncingFromSupabase) {
      this.pendingSupabaseSync = true;
      return;
    }
    clearTimeout(this.supabaseSyncTimer);
    this.supabaseSyncTimer = setTimeout(() => this.syncToSupabase(), 500);
  }

  /** Writes the current state into Supabase. */
  async syncToSupabase() {
    if (!this.supabaseEnabled) return;
    try {
      this.supabaseSyncTimer = null;
      this.syncingToSupabase = true;
      this.setSyncStatus("同步中", false);
      await this.supabaseStore.saveData(this.state);
      this.setSyncStatus("已同步", false);
    } catch (error) {
      console.warn(error);
      this.setSyncStatus("同步失敗", true);
    } finally {
      this.syncingToSupabase = false;
      if (this.pendingSupabaseSync) {
        this.pendingSupabaseSync = false;
        this.queueSupabaseSync();
      }
    }
  }

  /** Opens the Supabase settings dialog. */
  openDatabaseSettings() {
    this.supabaseConfig = this.storage.loadConfig();
    this.dom.supabaseUrlInput.value = this.supabaseConfig.url;
    this.dom.supabaseAnonKeyInput.value = this.supabaseConfig.anonKey;
    this.dom.databaseModal.showModal();
  }

  /** Saves Supabase settings and reloads remote data. */
  async saveDatabaseSettings(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(this.dom.databaseForm).entries());
    this.supabaseConfig = { url: data.url.trim(), anonKey: data.anonKey.trim() };
    this.storage.saveConfig(this.supabaseConfig);
    this.supabaseStore = new SupabasePMISStore(this.supabaseConfig);
    this.supabaseEnabled = this.supabaseStore.isConfigured();
    this.dom.databaseModal.close();
    this.toast(this.supabaseEnabled ? "Supabase 設定已儲存" : "已使用 LocalStorage 模式");
    if (this.supabaseEnabled) {
      await this.syncFromSupabase({ force: true, showToast: true });
      this.startSupabasePolling();
    } else {
      clearInterval(this.supabasePollTimer);
      this.setSyncStatus("使用本機模式", true);
    }
  }

  /** Clears Supabase settings and keeps LocalStorage fallback. */
  clearDatabaseSettings() {
    this.storage.clearConfig();
    this.supabaseConfig = { url: "", anonKey: "" };
    this.supabaseStore = new SupabasePMISStore(this.supabaseConfig);
    this.supabaseEnabled = false;
    clearInterval(this.supabasePollTimer);
    this.dom.supabaseUrlInput.value = "";
    this.dom.supabaseAnonKeyInput.value = "";
    this.setSyncStatus("使用本機模式", true);
  }

  /** Imports current LocalStorage-compatible state into Supabase. */
  async migrateLocalDataToSupabase() {
    const config = {
      url: this.dom.supabaseUrlInput.value.trim(),
      anonKey: this.dom.supabaseAnonKeyInput.value.trim()
    };
    const store = new SupabasePMISStore(config);
    if (!store.isConfigured()) {
      this.toast("請先填入 Supabase URL 與 Anon Key");
      return;
    }
    const ok = await this.confirm(
      "第一次匯入確認",
      "此操作會將目前本機資料覆蓋到 Supabase，僅限第一次匯入使用。",
      "確認覆蓋匯入"
    );
    if (!ok) return;
    try {
      const sourceData = this.localMigrationSnapshot
        ? this.migrate(JSON.parse(JSON.stringify(this.localMigrationSnapshot)))
        : this.state;
      await store.migrateFromLocalStorage(sourceData);
      this.state = sourceData;
      this.storage.save(this.state);
      this.storage.saveConfig(config);
      this.supabaseConfig = config;
      this.supabaseStore = store;
      this.supabaseEnabled = true;
      this.startSupabasePolling();
      this.setSyncStatus("已同步", false);
      this.renderAll();
      this.toast("LocalStorage 資料已匯入 Supabase");
    } catch (error) {
      console.warn(error);
      this.toast("匯入 Supabase 失敗，請確認資料表與權限");
    }
  }

  /** Generates a compact unique id. */
  uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Converts a date object into yyyy-mm-dd. */
  toDateInput(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  /** Formats yyyy-mm-dd into a readable Traditional Chinese date. */
  formatDate(dateText) {
    if (!dateText) return "-";
    return dateText.replaceAll("-", "/");
  }

  /** Returns today's yyyy-mm-dd string. */
  today() {
    return this.toDateInput(new Date());
  }

  /** Escapes user text before inserting it into HTML. */
  escape(text) {
    return String(text || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  /** Converts imported or edited amount values into safe numbers. */
  toNumber(value) {
    const number = Number(String(value ?? 0).replaceAll(",", ""));
    return Number.isFinite(number) ? number : 0;
  }

  /** Formats a project amount for dashboard/detail display. */
  formatCurrency(value) {
    return `NT$ ${this.toNumber(value).toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
  }

  /** Renders all major sections after data changes. */
  renderAll() {
    document.documentElement.dataset.theme = this.state.theme || "light";
    this.populateSelects();
    this.renderDashboard();
    this.renderCalendar();
    this.renderTasks();
    this.renderStatusManager();
    this.renderProjectTable();
    if (this.selectedProjectId && this.activeView === "fullProject") this.renderFullProjectDetail(this.selectedProjectId);
  }

  /** Switches between top-level pages. */
  switchView(view) {
    const titles = {
      dashboard: ["Dashboard", "ESG / ISO 顧問案件管理總覽"],
      calendar: ["月曆", "以月檢視與週檢視管理案件時程"],
      tasks: ["今日工作", "安排、勾選與排序今天的工作"],
      projects: ["專案列表", "搜尋、排序與篩選所有案件"],
      fullProject: ["Project Detail", "完整案件管理"]
    };
    this.activeView = view;
    this.dom.views.forEach(section => section.classList.toggle("active", section.id === `${view}View`));
    this.dom.navLinks.forEach(button => button.classList.toggle("active", button.dataset.view === view));
    this.dom.pageTitle.textContent = titles[view][0];
    this.dom.pageSubtitle.textContent = titles[view][1];
    this.dom.sidebar.classList.remove("open");
    if (view === "dashboard") this.renderDashboard();
    if (view === "calendar") this.renderCalendar();
    if (["dashboard", "calendar", "projects"].includes(view)) {
      this.syncFromSupabase({ force: false, showToast: false });
    }
  }

  /** Toggles light and dark theme. */
  toggleTheme() {
    this.state.theme = this.state.theme === "dark" ? "light" : "dark";
    this.save();
    this.renderAll();
  }

  /** Returns the status object for a status id. */
  getStatus(statusId) {
    return this.state.statuses.find(status => status.id === statusId) || { id: statusId, name: statusId, color: "#64748b" };
  }

  /** Returns reusable status badge HTML. */
  statusBadge(statusId) {
    const status = this.getStatus(statusId);
    return `<span class="status-pill" style="background:${status.color}">${this.escape(status.name)}</span>`;
  }

  /** Calculates dashboard metrics from project data. */
  getMetrics() {
    const today = this.today();
    const month = today.slice(0, 7);
    const active = this.state.projects.filter(project => project.status !== "Completed");
    return [
      { label: "今日案件數", value: active.filter(project => project.startDate <= today && project.dueDate >= today).length, action: "today" },
      { label: "進行中案件", value: active.length, action: "active" },
      { label: "等待客戶", value: active.filter(project => project.status === "Waiting Customer").length, action: "waiting" },
      { label: "已完成案件", value: this.state.projects.filter(project => project.status === "Completed").length, action: "completed" },
      { label: "本月新增案件", value: this.state.projects.filter(project => project.startDate.startsWith(month)).length, action: "monthNew" },
      { label: "本月結案案件", value: this.state.projects.filter(project => (project.completedDate || "").startsWith(month)).length, action: "monthClosed" },
      { label: "即將到期", value: active.filter(project => this.daysUntil(project.dueDate) <= 7 && this.daysUntil(project.dueDate) >= 0).length, action: "dueSoon" }
    ];
  }

  /** Draws dashboard metric cards, search results, and charts. */
  renderDashboard() {
    this.dom.metricGrid.innerHTML = this.getMetrics().map(metric => `
      <button class="metric-card" data-metric-action="${metric.action}">
        <small>${metric.label}</small>
        <strong>${metric.value}</strong>
        <span>共 ${metric.value} 件</span>
      </button>
    `).join("");
    this.dom.metricGrid.querySelectorAll("[data-metric-action]").forEach(card => {
      card.addEventListener("click", () => this.handleMetricClick(card.dataset.metricAction));
    });
    this.renderDashboardSearch();
    this.drawDonutChart("statusChart", this.countBy("status"), this.state.statuses.map(status => status.color));
    this.drawMonthlyChart("monthlyChart");
  }

  /** Handles dashboard card navigation and filters. */
  handleMetricClick(action) {
    this.clearFilters(false);
    this.quickFilter = null;
    const month = this.today().slice(0, 7);
    if (action === "today") {
      this.switchView("tasks");
      return;
    }
    if (action === "completed") this.setProjectTab("history", false);
    else this.setProjectTab("active", false);
    if (action === "waiting") this.dom.statusFilter.value = "Waiting Customer";
    if (action === "monthNew") this.dom.startFromFilter.value = `${month}-01`;
    if (action === "monthNew") this.dom.startToFilter.value = this.endOfMonth(month);
    if (action === "monthClosed") {
      this.setProjectTab("history", false);
      this.dom.sortKeySelect.value = "completedDate";
      this.dom.sortDirectionSelect.value = "desc";
      this.quickFilter = "monthClosed";
    }
    if (action === "dueSoon") {
      this.dom.dueFromFilter.value = this.today();
      const due = new Date();
      due.setDate(due.getDate() + 7);
      this.dom.dueToFilter.value = this.toDateInput(due);
    }
    this.switchView("projects");
    this.renderProjectTable();
  }

  /** Renders dashboard global search results. */
  renderDashboardSearch() {
    const keyword = this.dom.dashboardSearch.value.trim().toLowerCase();
    if (!keyword) {
      this.dom.dashboardSearchResults.innerHTML = "";
      return;
    }
    const results = this.state.projects.filter(project => [project.code, project.client, project.name].some(value => String(value).toLowerCase().includes(keyword))).slice(0, 8);
    this.dom.dashboardSearchResults.innerHTML = results.length ? results.map(project => `
      <button data-project-id="${project.id}">
        <strong>${this.escape(project.code)}</strong>
        <span>${this.escape(project.client)} · ${this.escape(project.name)}</span>
      </button>
    `).join("") : `<p>找不到符合的案件。</p>`;
    this.dom.dashboardSearchResults.querySelectorAll("[data-project-id]").forEach(button => {
      button.addEventListener("click", () => this.openFullProjectDetail(button.dataset.projectId));
    });
  }

  /** Counts projects by a specified field. */
  countBy(key) {
    return this.state.projects.reduce((acc, project) => {
      const label = key === "status" ? this.getStatus(project[key]).name : project[key];
      acc[label] = (acc[label] || 0) + 1;
      return acc;
    }, {});
  }

  /** Returns days between today and the supplied date string. */
  daysUntil(dateText) {
    const today = new Date(`${this.today()}T00:00:00`);
    const target = new Date(`${dateText}T00:00:00`);
    return Math.ceil((target - today) / 86400000);
  }

  /** Returns the last day string of a yyyy-mm month. */
  endOfMonth(monthText) {
    const [year, month] = monthText.split("-").map(Number);
    return this.toDateInput(new Date(year, month, 0));
  }

  /** Prepares a canvas for sharp rendering on high density screens. */
  setupCanvas(id) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = Number(canvas.getAttribute("height")) * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, canvas.height / dpr);
    return { ctx, width: rect.width, height: canvas.height / dpr };
  }

  /** Draws a donut chart with labels and legend. */
  drawDonutChart(id, data, colors) {
    const setup = this.setupCanvas(id);
    if (!setup || setup.width === 0) return;
    const { ctx, width, height } = setup;
    const entries = Object.entries(data);
    const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
    let start = -Math.PI / 2;
    entries.forEach(([, value], index) => {
      const slice = value / total * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(width * 0.3, height * 0.5);
      ctx.arc(width * 0.3, height * 0.5, 70, start, start + slice);
      ctx.fillStyle = colors[index % colors.length] || "#64748b";
      ctx.fill();
      start += slice;
    });
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(width * 0.3, height * 0.5, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    this.drawLegend(ctx, entries, colors, width * 0.58, 42);
  }

  /** Draws a grouped monthly project and close count chart. */
  drawMonthlyChart(id) {
    const setup = this.setupCanvas(id);
    if (!setup || setup.width === 0) return;
    const { ctx, width, height } = setup;
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setMonth(date.getMonth() - 5 + index);
      return this.toDateInput(date).slice(0, 7);
    });
    const created = months.map(month => this.state.projects.filter(project => project.startDate.startsWith(month)).length);
    const closed = months.map(month => this.state.projects.filter(project => (project.completedDate || "").startsWith(month)).length);
    const max = Math.max(...created, ...closed, 1);
    const groupWidth = (width - 60) / months.length;
    months.forEach((month, index) => {
      const x = 34 + index * groupWidth;
      const h1 = created[index] / max * (height - 82);
      const h2 = closed[index] / max * (height - 82);
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(x, height - 42 - h1, 16, h1);
      ctx.fillStyle = "#16a34a";
      ctx.fillRect(x + 20, height - 42 - h2, 16, h2);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted");
      ctx.font = "12px sans-serif";
      ctx.fillText(month.slice(5), x, height - 18);
    });
    this.drawLegend(ctx, [["新增", 0], ["結案", 0]], ["#2563eb", "#16a34a"], width - 130, 22);
  }

  /** Draws a simple color legend on a canvas. */
  drawLegend(ctx, entries, colors, x, y) {
    ctx.font = "13px sans-serif";
    entries.forEach(([label, value], index) => {
      ctx.fillStyle = colors[index % colors.length] || "#64748b";
      ctx.fillRect(x, y + index * 24, 12, 12);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text");
      ctx.fillText(`${label} ${value ? value : ""}`, x + 20, y + 11 + index * 24);
    });
  }

  /** Moves the calendar by one month or one week. */
  moveCalendar(direction) {
    if (this.calendarMode === "month") this.calendarDate.setMonth(this.calendarDate.getMonth() + direction);
    else this.calendarDate.setDate(this.calendarDate.getDate() + direction * 7);
    this.renderCalendar();
  }

  /** Changes the calendar display mode. */
  setCalendarMode(mode) {
    this.calendarMode = mode;
    document.getElementById("monthMode").classList.toggle("active", mode === "month");
    document.getElementById("weekMode").classList.toggle("active", mode === "week");
    this.renderCalendar();
  }

  /** Toggles the right-side calendar detail panel. */
  toggleCalendarDetail() {
    this.calendarDetailCollapsed = !this.calendarDetailCollapsed;
    this.dom.calendarLayout.classList.toggle("detail-collapsed", this.calendarDetailCollapsed);
    this.dom.calendarDetailToggle.textContent = this.calendarDetailCollapsed ? "Expand" : "Collapse";
  }

  /** Renders the month or week calendar. */
  renderCalendar() {
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    const dates = this.calendarMode === "month" ? this.getMonthDates(this.calendarDate) : this.getWeekDates(this.calendarDate);
    this.dom.calendarTitle.textContent = this.calendarMode === "month"
      ? `${this.calendarDate.getFullYear()} 年 ${this.calendarDate.getMonth() + 1} 月`
      : `${this.formatDate(this.toDateInput(dates[0]))} - ${this.formatDate(this.toDateInput(dates[6]))}`;
    this.dom.calendarLayout.classList.toggle("detail-collapsed", this.calendarDetailCollapsed);
    this.dom.calendarDetailToggle.textContent = this.calendarDetailCollapsed ? "Expand" : "Collapse";
    this.dom.calendarGrid.innerHTML = weekdays.map(day => `<div class="weekday">${day}</div>`).join("") + dates.map(date => this.renderDayCell(date)).join("");
    this.dom.calendarGrid.querySelectorAll(".day-cell").forEach(cell => cell.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      this.selectedDate = cell.dataset.date;
      this.selectedCalendarProjectId = null;
      this.calendarPopoverDate = "";
      this.renderCalendar();
    }));
    this.dom.calendarGrid.querySelectorAll("[data-calendar-project]").forEach(button => button.addEventListener("click", event => {
      event.stopPropagation();
      this.selectedCalendarProjectId = button.dataset.calendarProject;
      this.selectedDate = button.dataset.date;
      this.calendarPopoverDate = "";
      this.quickActivityExpanded = false;
      this.renderCalendar();
    }));
    this.dom.calendarGrid.querySelectorAll("[data-calendar-more]").forEach(button => button.addEventListener("click", event => {
      event.stopPropagation();
      this.calendarPopoverDate = this.calendarPopoverDate === button.dataset.calendarMore ? "" : button.dataset.calendarMore;
      this.selectedDate = button.dataset.calendarMore;
      this.selectedCalendarProjectId = null;
      this.renderCalendar();
    }));
    this.renderSelectedDate();
  }

  /** Gets all dates displayed in the current month view. */
  getMonthDates(date) {
    const first = new Date(date.getFullYear(), date.getMonth(), 1);
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const item = new Date(start);
      item.setDate(start.getDate() + index);
      return item;
    });
  }

  /** Gets all dates displayed in the current week view. */
  getWeekDates(date) {
    const start = new Date(date);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 7 }, (_, index) => {
      const item = new Date(start);
      item.setDate(start.getDate() + index);
      return item;
    });
  }

  /** Renders one day cell with up to three project pills. */
  renderDayCell(date) {
    const dateText = this.toDateInput(date);
    const projects = this.projectsOnDate(dateText).filter(project => project.status !== "Completed");
    const isMuted = this.calendarMode === "month" && date.getMonth() !== this.calendarDate.getMonth();
    const pills = projects.slice(0, 3).map(project => `<button class="event-pill" data-calendar-project="${project.id}" data-date="${dateText}" style="background:${this.getStatus(project.status).color}">${this.escape(project.name)}</button>`).join("");
    const more = projects.length > 3 ? `<button class="event-pill more-pill" data-calendar-more="${dateText}" style="background:#64748b">+${projects.length - 3} More</button>` : "";
    const popover = this.calendarPopoverDate === dateText ? this.renderCalendarPopover(dateText, projects) : "";
    return `
      <div class="day-cell ${isMuted ? "muted" : ""} ${dateText === this.selectedDate ? "selected" : ""}" data-date="${dateText}">
        <div class="day-number"><span>${date.getDate()}</span></div>
        ${pills}${more}
        ${popover}
      </div>
    `;
  }

  /** Returns the popover listing all projects on a crowded calendar day. */
  renderCalendarPopover(dateText, projects) {
    return `
      <div class="calendar-popover">
        <strong>${this.formatDate(dateText)}</strong>
        <small>共 ${projects.length} 個案件</small>
        <div>${projects.map(project => `
          <button data-calendar-project="${project.id}" data-date="${dateText}">
            <span style="background:${this.getStatus(project.status).color}"></span>
            ${this.escape(project.client)} ${this.escape(project.type)}
          </button>`).join("")}</div>
      </div>
    `;
  }

  /** Finds active projects whose date range includes a specified date. */
  projectsOnDate(dateText) {
    return this.state.projects.filter(project => project.startDate <= dateText && project.dueDate >= dateText);
  }

  /** Renders the right-side selected date project list. */
  renderSelectedDate() {
    const projects = this.projectsOnDate(this.selectedDate).filter(project => project.status !== "Completed");
    this.dom.selectedDateTitle.textContent = `${this.formatDate(this.selectedDate)} 快速檢視`;
    const selectedProject = projects.find(project => project.id === this.selectedCalendarProjectId);
    this.dom.selectedDateProjects.innerHTML = selectedProject
      ? this.renderCalendarQuickView(selectedProject)
      : `<p>${projects.length ? "請點選月曆中的案件查看進度。" : "這一天沒有進行中的案件。"}</p>`;
    this.dom.selectedDateProjects.querySelectorAll("[data-full-project]").forEach(button => {
      button.addEventListener("click", () => this.openFullProjectDetail(button.dataset.fullProject));
    });
    this.dom.selectedDateProjects.querySelectorAll("[data-view-all-activity]").forEach(button => {
      button.addEventListener("click", () => {
        this.quickActivityExpanded = true;
        this.renderSelectedDate();
      });
    });
  }

  /** Returns a calendar quick view card for read-only project status review. */
  renderCalendarQuickView(project) {
    const unfinished = this.getProjectTasks(project).filter(item => !item.done).slice(0, 5);
    return `
      <article class="quick-view-card">
        <header class="quick-view-header">
          <h3>${this.escape(project.name)}</h3>
          ${this.statusBadge(project.status)}
        </header>
        <dl class="quick-view-meta">
          <div><dt>客戶</dt><dd>${this.escape(project.client)}</dd></div>
          <div><dt>專案類型</dt><dd>${this.escape(project.type)}</dd></div>
          <div><dt>開始日期</dt><dd>${this.formatDate(project.startDate)}</dd></div>
          <div><dt>預計完成</dt><dd>${this.formatDate(project.dueDate)}</dd></div>
        </dl>
        <div class="quick-view-block">
          <strong>案件流程 Milestone</strong>
          <ul class="quick-progress-list">${this.renderProgressSummary(project)}</ul>
        </div>
        <div class="quick-view-block">
          <strong>工作歷程</strong>
          <div class="activity-list">${this.renderActivityTimeline(project)}</div>
        </div>
        <div class="quick-view-block">
          <strong>未完成工作</strong>
          <ul class="quick-unfinished-list">${unfinished.length ? unfinished.map(item => `<li>□ ${this.escape(item.title)}</li>`).join("") : "<li>目前沒有未完成工作。</li>"}</ul>
        </div>
        <button class="primary-button quick-full-button" data-full-project="${project.id}">前往完整專案</button>
      </article>
    `;
  }

  /** Builds progress summary bullets from timeline and checklist state. */
  renderProgressSummary(project) {
    const summary = project.timeline.slice(0, 7).map(item => `${item.done ? "✔" : "○"} ${this.escape(item.title)}`);
    if (!summary.length) project.checklist.slice(0, 7).forEach(item => summary.push(`${item.done ? "✔" : "○"} ${this.escape(item.title)}`));
    return summary.map(text => `<li>${text}</li>`).join("");
  }

  /** Builds a compact activity timeline from existing project data. */
  renderActivityTimeline(project) {
    const activities = this.buildActivities(project).slice(0, this.quickActivityExpanded ? 999 : 10);
    if (!activities.length) return `<p>尚無工作歷程。</p>`;
    const rows = activities.map(item => `
      <div class="activity-item">
        <time>${this.formatActivityDateTime(item)}</time>
        <span>${this.escape(item.title)}</span>
        <strong>${this.escape(item.description)}</strong>
      </div>
    `).join("");
    const all = this.buildActivities(project).length;
    const toggle = all > 10 && !this.quickActivityExpanded ? `<button class="ghost-button quick-activity-all" data-view-all-activity="${project.id}">查看全部</button>` : "";
    return rows + toggle;
  }

  /** Derives readable activity entries without changing the stored project schema. */
  buildActivities(project) {
    const logs = this.getProjectActivityLogs(project);
    if (logs.length) return logs.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return this.buildLegacyActivities(project);
  }

  /** Builds fallback timeline entries for very old records without activity logs. */
  buildLegacyActivities(project) {
    const activities = [];
    project.notes.forEach(note => activities.push(this.legacyActivity(project, "note_created", "新增備註", this.truncate(note.text), note.date, note.time)));
    project.attachments.forEach(file => activities.push(this.legacyActivity(project, "attachment_created", "新增附件", `新增附件：${file.name}`, project.startDate, "")));
    this.getProjectTasks(project).forEach(task => activities.push(this.legacyActivity(project, task.done ? "task_completed" : "task_created", task.done ? "完成工作" : "新增工作", `${task.done ? "完成工作" : "新增工作"}：${task.title}`, task.date || project.startDate, task.time || "")));
    project.checklist.filter(item => item.done).forEach(item => activities.push(this.legacyActivity(project, "milestone_completed", "完成案件流程", `完成流程：${item.title}`, project.startDate, "")));
    project.timeline.filter(item => item.date).forEach(item => activities.push(this.legacyActivity(project, item.done ? "milestone_completed" : "milestone_created", item.done ? "完成案件流程" : "新增案件流程", item.title, item.date, "")));
    return activities.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Converts legacy date/time facts into a display-compatible activity log shape. */
  legacyActivity(project, type, title, description, date, time) {
    return this.createActivityLog(project, type, title, description, {}, date || project.startDate || this.today(), time || "00:00");
  }

  /** Returns project-level daily tasks while keeping older project records compatible. */
  getProjectTasks(project) {
    if (!Array.isArray(project.tasks)) project.tasks = [];
    return project.tasks;
  }

  /** Returns formal project activity logs while keeping older project records compatible. */
  getProjectActivityLogs(project) {
    if (!Array.isArray(project.activityLogs)) project.activityLogs = [];
    return project.activityLogs;
  }

  /** Creates one formal activity log object. */
  createActivityLog(project, type, title, description, meta = {}, date = null, time = null) {
    const createdAt = date
      ? `${date}T${time || "00:00"}:00`
      : this.localTimestamp();
    return {
      id: `act_${this.uid()}`,
      projectId: project.id,
      type,
      title,
      description,
      createdAt,
      createdBy: project.owner || "系統",
      meta
    };
  }

  /** Adds one formal activity log entry and avoids immediate duplicate logs. */
  addActivityLog(project, type, title, description, meta = {}) {
    const logs = this.getProjectActivityLogs(project);
    const latest = logs[0];
    if (latest && latest.type === type && latest.description === description && Date.now() - new Date(latest.createdAt).getTime() < 1200) return latest;
    const log = this.createActivityLog(project, type, title, description, meta);
    logs.unshift(log);
    return log;
  }

  /** Keeps older helper calls compatible with the new activity log format. */
  addProjectActivity(project, action, content) {
    this.addActivityLog(project, "activity", action, content);
  }

  /** Shortens long user text for activity descriptions. */
  truncate(text, limit = 50) {
    const value = String(text || "");
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }

  /** Formats one activity log timestamp as yyyy/mm/dd HH:mm. */
  formatActivityDateTime(log) {
    const [date = "", time = ""] = String(log.createdAt || "").split("T");
    return `${this.formatDate(date)} ${time.slice(0, 5)}`.trim();
  }

  /** Returns a local timestamp without timezone conversion. */
  localTimestamp() {
    const now = new Date();
    return `${this.toDateInput(now)}T${now.toTimeString().slice(0, 8)}`;
  }

  /** Renders today's task list. */
  renderTasks() {
    this.dom.taskList.innerHTML = this.state.tasks.map((task, index) => `
      <li class="task-item ${task.done ? "done" : ""}">
        <input type="checkbox" ${task.done ? "checked" : ""} data-task-toggle="${task.id}">
        <span>${this.escape(task.title)}</span>
        <div class="task-actions">
          <button data-task-up="${task.id}" ${index === 0 ? "disabled" : ""}>↑</button>
          <button data-task-down="${task.id}" ${index === this.state.tasks.length - 1 ? "disabled" : ""}>↓</button>
          <button data-task-delete="${task.id}">×</button>
        </div>
      </li>
    `).join("");
    this.dom.taskList.querySelectorAll("[data-task-toggle]").forEach(input => input.addEventListener("change", () => this.toggleTask(input.dataset.taskToggle)));
    this.dom.taskList.querySelectorAll("[data-task-up]").forEach(button => button.addEventListener("click", () => this.moveTask(button.dataset.taskUp, -1)));
    this.dom.taskList.querySelectorAll("[data-task-down]").forEach(button => button.addEventListener("click", () => this.moveTask(button.dataset.taskDown, 1)));
    this.dom.taskList.querySelectorAll("[data-task-delete]").forEach(button => button.addEventListener("click", () => this.deleteTask(button.dataset.taskDelete)));
  }

  /** Adds a new task to today's task list. */
  addTodayTask(event) {
    event.preventDefault();
    this.state.tasks.push({ id: this.uid(), title: this.dom.taskInput.value.trim(), done: false });
    this.dom.taskInput.value = "";
    this.save();
    this.renderTasks();
  }

  /** Toggles one task as completed or unfinished. */
  toggleTask(id) {
    const task = this.state.tasks.find(item => item.id === id);
    task.done = !task.done;
    this.save();
    this.renderTasks();
  }

  /** Moves one task up or down in the list. */
  moveTask(id, direction) {
    const index = this.state.tasks.findIndex(item => item.id === id);
    const target = index + direction;
    if (target < 0 || target >= this.state.tasks.length) return;
    [this.state.tasks[index], this.state.tasks[target]] = [this.state.tasks[target], this.state.tasks[index]];
    this.save();
    this.renderTasks();
  }

  /** Deletes one task from today's task list. */
  deleteTask(id) {
    this.state.tasks = this.state.tasks.filter(item => item.id !== id);
    this.save();
    this.renderTasks();
  }

  /** Opens the new project modal and sets default dates and code. */
  openProjectModal() {
    this.dom.projectForm.reset();
    this.dom.projectForm.elements.code.value = this.nextProjectCode();
    this.dom.projectForm.elements.startDate.value = this.today();
    const due = new Date();
    due.setDate(due.getDate() + 45);
    this.dom.projectForm.elements.dueDate.value = this.toDateInput(due);
    this.dom.projectModal.showModal();
  }

  /** Returns the next suggested project code without forcing the user to keep it. */
  nextProjectCode() {
    return `P-${new Date().getFullYear()}-${String(this.state.projects.length + 1).padStart(3, "0")}`;
  }

  /** Validates project code uniqueness. */
  isCodeDuplicate(code, currentId = null) {
    return this.state.projects.some(project => project.id !== currentId && project.code.trim().toLowerCase() === code.trim().toLowerCase());
  }

  /** Creates a new project from modal form values. */
  createProject(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(this.dom.projectForm).entries());
    if (this.isCodeDuplicate(data.code)) {
      this.toast("案件編號已存在。");
      return;
    }
    const project = {
      id: this.uid(),
      code: data.code.trim(),
      client: data.client,
      name: data.name,
      type: data.type,
      contact: "",
      phone: "",
      email: "",
      owner: data.owner,
      startDate: data.startDate,
      dueDate: data.dueDate,
      status: "In Progress",
      progress: 0,
      completedDate: "",
      totalAmount: 0,
      receivedAmount: 0,
      unreceivedAmount: 0,
      paymentProgress: "",
      contractPeriod: "",
      checklist: this.milestoneTemplate.map(title => ({ id: this.uid(), title, done: false })),
      tasks: [],
      activityLogs: [],
      notes: [],
      attachments: [],
      timeline: ["建立案件", "Kickoff", "第一次輔導", "收資料", "初稿", "查驗", "結案"].map((title, index) => ({ id: this.uid(), title, date: index === 0 ? data.startDate : "", done: index === 0 }))
    };
    this.addActivityLog(project, "project_created", "建立案件", `建立案件：「${project.name}」`, { projectCode: project.code });
    this.state.projects.unshift(project);
    this.dom.projectModal.close();
    this.save();
    this.renderAll();
    this.openFullProjectDetail(project.id);
  }

  /** Switches between active projects and historical completed projects. */
  setProjectTab(tab, render = true) {
    this.projectTab = tab;
    this.dom.activeProjectsTab.classList.toggle("active", tab === "active");
    this.dom.historyProjectsTab.classList.toggle("active", tab === "history");
    this.dom.projectListHint.textContent = tab === "active" ? "進行中專案" : "歷史專區";
    if (tab === "history" && this.dom.sortKeySelect.value !== "completedDate") this.dom.sortKeySelect.value = "completedDate";
    if (render) this.renderProjectTable();
  }

  /** Changes current project table sort settings from table headers. */
  changeSort(key) {
    this.sort.direction = this.sort.key === key && this.sort.direction === "asc" ? "desc" : "asc";
    this.sort.key = key;
    this.dom.sortKeySelect.value = key;
    this.dom.sortDirectionSelect.value = this.sort.direction;
    this.updateSortDirectionLabels();
    this.renderProjectTable();
  }

  /** Changes current project table sort settings from controls. */
  changeSortFromSelects() {
    this.sort.key = this.dom.sortKeySelect.value;
    this.sort.direction = this.dom.sortDirectionSelect.value;
    this.updateSortDirectionLabels();
    this.renderProjectTable();
  }

  /** Updates sort direction labels to match date or text sorting. */
  updateSortDirectionLabels() {
    if (!this.dom?.sortKeySelect || !this.dom?.sortDirectionSelect) return;
    const isDate = ["startDate", "dueDate", "completedDate"].includes(this.dom.sortKeySelect.value);
    this.dom.sortDirectionSelect.options[0].textContent = isDate ? "最早→最晚" : "A→Z";
    this.dom.sortDirectionSelect.options[1].textContent = isDate ? "最晚→最早" : "Z→A";
  }

  /** Clears all project filters. */
  clearFilters(render = true) {
    this.quickFilter = null;
    [this.dom.projectSearch, this.dom.clientFilter, this.dom.startFromFilter, this.dom.startToFilter, this.dom.dueFromFilter, this.dom.dueToFilter].forEach(input => input.value = "");
    this.dom.statusFilter.value = "all";
    this.dom.typeFilter.value = "all";
    this.dom.ownerFilter.value = "all";
    if (render) this.renderProjectTable();
  }

  /** Returns projects after current tab, search, filter, and sort rules. */
  getFilteredProjects() {
    const keyword = this.dom.projectSearch.value.trim().toLowerCase();
    const client = this.dom.clientFilter.value.trim().toLowerCase();
    const status = this.dom.statusFilter.value;
    const type = this.dom.typeFilter.value;
    const owner = this.dom.ownerFilter.value;
    const startFrom = this.dom.startFromFilter.value;
    const startTo = this.dom.startToFilter.value;
    const dueFrom = this.dom.dueFromFilter.value;
    const dueTo = this.dom.dueToFilter.value;
    return this.state.projects
      .filter(project => this.projectTab === "history" ? project.status === "Completed" : project.status !== "Completed")
      .filter(project => status === "all" || project.status === status)
      .filter(project => type === "all" || project.type === type)
      .filter(project => owner === "all" || project.owner === owner)
      .filter(project => !client || project.client.toLowerCase().includes(client))
      .filter(project => !startFrom || project.startDate >= startFrom)
      .filter(project => !startTo || project.startDate <= startTo)
      .filter(project => !dueFrom || project.dueDate >= dueFrom)
      .filter(project => !dueTo || project.dueDate <= dueTo)
      .filter(project => this.quickFilter !== "monthClosed" || (project.completedDate || "").startsWith(this.today().slice(0, 7)))
      .filter(project => !keyword || [project.code, project.client, project.name, project.type, project.owner].some(value => String(value).toLowerCase().includes(keyword)))
      .sort((a, b) => {
        const av = a[this.sort.key] || "";
        const bv = b[this.sort.key] || "";
        const result = av > bv ? 1 : av < bv ? -1 : 0;
        return this.sort.direction === "asc" ? result : -result;
      });
  }

  /** Renders the project table for active or historical projects. */
  renderProjectTable() {
    this.renderOwnerOptions();
    this.dom.activeProjectsTab.classList.toggle("active", this.projectTab === "active");
    this.dom.historyProjectsTab.classList.toggle("active", this.projectTab === "history");
    if (this.projectTab === "history") this.renderHistoryTable();
    else this.renderActiveTable();
    this.bindTableActions();
  }

  /** Renders the active project table. */
  renderActiveTable() {
    this.dom.projectTableHead.innerHTML = `
      <tr>
        <th data-sort="code">案件編號</th>
        <th data-sort="client">客戶</th>
        <th data-sort="name">專案名稱</th>
        <th data-sort="type">專案類型</th>
        <th data-sort="startDate">開始日</th>
        <th data-sort="dueDate">截止日</th>
        <th data-sort="status">目前狀態</th>
        <th data-sort="progress">完成率</th>
        <th data-sort="owner">負責人</th>
        <th>操作</th>
      </tr>`;
    this.dom.projectTableBody.innerHTML = this.getFilteredProjects().map(project => `
      <tr data-project-id="${project.id}">
        <td>${this.escape(project.code)}</td>
        <td>${this.escape(project.client)}</td>
        <td>${this.escape(project.name)}</td>
        <td>${this.escape(project.type)}</td>
        <td>${this.formatDate(project.startDate)}</td>
        <td>${this.formatDate(project.dueDate)}</td>
        <td>${this.statusBadge(project.status)}</td>
        <td><div class="progress"><span style="width:${project.progress}%"></span></div><small>${project.progress}%</small></td>
        <td>${this.escape(project.owner)}</td>
        <td>${this.rowActions(project, false)}</td>
      </tr>
    `).join("");
  }

  /** Renders the historical completed project table. */
  renderHistoryTable() {
    this.dom.projectTableHead.innerHTML = `
      <tr>
        <th data-sort="code">案件編號</th>
        <th data-sort="client">客戶</th>
        <th data-sort="name">專案名稱</th>
        <th data-sort="type">專案類型</th>
        <th data-sort="startDate">開始日期</th>
        <th data-sort="completedDate">完成日期</th>
        <th data-sort="owner">負責人</th>
        <th>操作</th>
      </tr>`;
    this.dom.projectTableBody.innerHTML = this.getFilteredProjects().map(project => `
      <tr data-project-id="${project.id}">
        <td>${this.escape(project.code)}</td>
        <td>${this.escape(project.client)}</td>
        <td>${this.escape(project.name)}</td>
        <td>${this.escape(project.type)}</td>
        <td>${this.formatDate(project.startDate)}</td>
        <td>${this.formatDate(project.completedDate)}</td>
        <td>${this.escape(project.owner)}</td>
        <td>${this.rowActions(project, true)}</td>
      </tr>
    `).join("");
  }

  /** Returns quick action buttons for a table row. */
  rowActions(project, isHistory) {
    const reopen = isHistory ? `<button data-action="reopen" data-project-id="${project.id}">重新開啟</button>` : `<button data-action="close" data-project-id="${project.id}">📦 結案</button>`;
    return `
      <div class="row-actions">
        <button data-action="view" data-project-id="${project.id}">👁 查看</button>
        <button data-action="edit" data-project-id="${project.id}">✏ 編輯</button>
        <button data-action="copy" data-project-id="${project.id}">📋 複製案件</button>
        ${reopen}
        <button data-action="delete" data-project-id="${project.id}">🗑 刪除</button>
      </div>`;
  }

  /** Binds table row and quick action events. */
  bindTableActions() {
    this.dom.projectTableBody.querySelectorAll("tr[data-project-id]").forEach(row => {
      row.addEventListener("click", () => this.openFullProjectDetail(row.dataset.projectId));
    });
    this.dom.projectTableBody.querySelectorAll("[data-action]").forEach(button => {
      button.addEventListener("click", event => {
        event.stopPropagation();
        this.handleRowAction(button.dataset.action, button.dataset.projectId);
      });
    });
  }

  /** Performs one quick action selected from a project table row. */
  handleRowAction(action, projectId) {
    const project = this.state.projects.find(item => item.id === projectId);
    if (!project) return;
    if (action === "view" || action === "edit") this.openFullProjectDetail(projectId);
    if (action === "copy") this.copyProject(project);
    if (action === "close") this.closeProject(project);
    if (action === "delete") this.deleteProject(project);
    if (action === "reopen") this.reopenProject(project);
  }

  /** Creates a duplicate project with a unique project code. */
  copyProject(project) {
    const copy = JSON.parse(JSON.stringify(project));
    copy.id = this.uid();
    copy.code = `${project.code}-COPY`;
    let counter = 2;
    while (this.isCodeDuplicate(copy.code)) copy.code = `${project.code}-COPY-${counter++}`;
    copy.name = `${project.name} 複製`;
    copy.status = "In Progress";
    copy.completedDate = "";
    this.state.projects.unshift(copy);
    this.save();
    this.renderAll();
    this.openFullProjectDetail(copy.id);
  }

  /** Opens the full project management view in the main workspace. */
  openFullProjectDetail(id) {
    this.selectedProjectId = id;
    this.closeProjectDetail();
    this.switchView("fullProject");
    this.renderFullProjectDetail(id);
  }

  /** Renders the dense full project detail page. */
  renderFullProjectDetail(id) {
    const project = this.state.projects.find(item => item.id === id);
    if (!project) {
      this.switchView("projects");
      return;
    }
    this.dom.pageTitle.textContent = "Project Detail";
    this.dom.pageSubtitle.textContent = `${project.code} · ${project.client}`;
    this.dom.fullProjectContent.innerHTML = `
      <header class="full-detail-header">
        <button class="ghost-button" id="backToProjectsBtn">返回專案列表</button>
        <div>
          <h2>${this.escape(project.name)}</h2>
          <div class="full-detail-meta">
            <span>${this.escape(project.type)}</span>
            ${this.statusBadge(project.status)}
          </div>
        </div>
        <div class="full-detail-actions">
          ${project.status === "Completed" ? `<button class="primary-button" id="reopenProjectAction">重新開啟</button>` : `<button class="danger-button" id="closeProjectAction">Close Project</button>`}
          <button class="danger-button" id="deleteProjectAction">🗑 刪除</button>
        </div>
      </header>
      <div class="full-detail-grid">
        ${this.renderFullBasicInfo(project)}
        ${this.renderFullChecklist(project)}
        ${this.renderFullTasks(project)}
        ${this.renderFullNotes(project)}
        ${this.renderFullAttachments(project)}
        ${this.renderFullTimeline(project)}
      </div>
    `;
    this.bindFullProjectEvents(project.id);
  }

  /** Returns dense basic project information for the full detail page. */
  renderFullBasicInfo(project) {
    const statusOptions = this.state.statuses.map(status => `<option value="${this.escape(status.id)}" ${project.status === status.id ? "selected" : ""}>${this.escape(status.name)}</option>`).join("");
    const fields = [
      ["客戶", project.client],
      ["聯絡人", project.contact || "-"],
      ["電話", project.phone || "-"],
      ["Email", project.email || "-"],
      ["負責顧問", project.owner],
      ["開始日", this.formatDate(project.startDate)],
      ["截止日", this.formatDate(project.dueDate)],
      ["完成日", this.formatDate(project.completedDate)],
      ["專案總額", this.formatCurrency(project.totalAmount)],
      ["已收金額", this.formatCurrency(project.receivedAmount)],
      ["未收金額", this.formatCurrency(project.unreceivedAmount)]
    ];
    return `
      <section class="full-card">
        <h3>基本資料</h3>
        <form class="detail-edit-form full-edit-form" data-update-project-meta>
          <label>案件編號<input name="code" value="${this.escape(project.code)}" required></label>
          <label>目前狀態<select name="status">${statusOptions}</select></label>
          <button class="primary-button">更新</button>
        </form>
        <form class="detail-edit-form finance-edit-form" data-update-project-finance>
          <label>專案總額<input name="totalAmount" type="number" min="0" step="1" value="${this.toNumber(project.totalAmount)}"></label>
          <label>已收金額<input name="receivedAmount" type="number" min="0" step="1" value="${this.toNumber(project.receivedAmount)}"></label>
          <label>未收金額<input name="unreceivedAmount" type="number" min="0" step="1" value="${this.toNumber(project.unreceivedAmount)}"></label>
          <button class="primary-button">更新金額</button>
        </form>
        <div class="full-info-grid">${fields.map(([label, value]) => `<div><small>${label}</small><strong>${this.escape(value)}</strong></div>`).join("")}</div>
      </section>`;
  }

  /** Returns dense checklist management for the full detail page. */
  renderFullChecklist(project) {
    return `
      <section class="full-card">
        <h3>案件流程 Milestone</h3>
        <form class="mini-form" data-add-checklist><input name="title" placeholder="新增流程節點" required><button class="primary-button">新增</button></form>
        <div class="compact-list">${project.checklist.map(item => `
          <div class="compact-row ${item.done ? "done" : ""}" draggable="true" data-milestone-row="${item.id}">
            <label><input type="checkbox" data-check-toggle="${item.id}" ${item.done ? "checked" : ""}> <span>${this.escape(item.title)}</span></label>
            <div class="task-actions"><button data-check-edit="${item.id}">改</button><button data-check-delete="${item.id}">×</button><span class="drag-handle">↕</span></div>
          </div>`).join("")}</div>
      </section>`;
  }

  /** Returns project-level task management separated from milestones. */
  renderFullTasks(project) {
    const tasks = this.getProjectTasks(project);
    return `
      <section class="full-card">
        <h3>工作事項 Task</h3>
        <form class="mini-form" data-add-project-task><input name="title" placeholder="例如：修改14064報告、客戶電話、收資料" required><button class="primary-button">新增</button></form>
        <div class="compact-list">${tasks.map(task => `
          <div class="compact-row ${task.done ? "done" : ""}">
            <label><input type="checkbox" data-project-task-toggle="${task.id}" ${task.done ? "checked" : ""}> <span>${this.escape(task.title)}</span></label>
            <div class="task-actions"><button data-project-task-edit="${task.id}">改</button><button data-project-task-delete="${task.id}">×</button></div>
          </div>`).join("") || "<p>尚無工作事項。</p>"}</div>
      </section>`;
  }

  /** Returns dense notes management for the full detail page. */
  renderFullNotes(project) {
    return `
      <section class="full-card">
        <h3>備註</h3>
        <form class="mini-form note-form" data-add-note><input name="date" type="date" value="${this.today()}" required><input name="text" placeholder="例如：今天收到天然氣資料" required><button class="primary-button">新增</button></form>
        <div class="compact-list">${project.notes.map(note => `
          <div class="compact-row"><div><time>${this.formatDate(note.date)} ${note.time}</time><p>${this.escape(note.text)}</p></div><button class="icon-button" data-note-delete="${note.id}">×</button></div>`).join("") || "<p>尚無備註。</p>"}</div>
      </section>`;
  }

  /** Returns dense attachment management for the full detail page. */
  renderFullAttachments(project) {
    return `
      <section class="full-card">
        <h3>附件</h3>
        <form class="form-grid compact-attachment-form" data-add-attachment>
          <input name="name" placeholder="附件名稱" required>
          <input name="description" placeholder="附件說明">
          <input name="link" placeholder="附件連結">
          <button class="primary-button">新增</button>
        </form>
        <ul class="attachment-list">${project.attachments.map(file => `
          <li><span>📄 ${this.escape(file.name)}</span><small>${this.escape(file.description)} ${file.link ? ` · ${this.escape(file.link)}` : ""}</small><button class="icon-button" data-attachment-delete="${file.id}">×</button></li>`).join("") || "<li>尚無附件。</li>"}</ul>
      </section>`;
  }

  /** Returns a compact timeline for the full detail page. */
  renderFullTimeline(project) {
    const activities = this.buildActivities(project);
    return `
      <section class="full-card">
        <h3>Activity Timeline</h3>
        <div class="compact-timeline">${activities.length ? activities.map(item => `
          <div><time>${this.formatActivityDateTime(item)}</time><span>${this.escape(item.title)}｜${this.escape(item.description)}</span></div>`).join("") : "<p>尚無歷程。</p>"}</div>
      </section>`;
  }

  /** Attaches full detail events to the main page project view. */
  bindFullProjectEvents(projectId) {
    const project = this.state.projects.find(item => item.id === projectId);
    const container = this.dom.fullProjectContent;
    document.getElementById("backToProjectsBtn").addEventListener("click", () => this.switchView("projects"));
    const metaForm = container.querySelector("[data-update-project-meta]");
    const financeForm = container.querySelector("[data-update-project-finance]");
    const checklistForm = container.querySelector("[data-add-checklist]");
    const projectTaskForm = container.querySelector("[data-add-project-task]");
    const noteForm = container.querySelector("[data-add-note]");
    const attachmentForm = container.querySelector("[data-add-attachment]");
    if (metaForm) metaForm.addEventListener("submit", event => this.updateProjectMeta(event, project));
    if (financeForm) financeForm.addEventListener("submit", event => this.updateProjectFinance(event, project));
    if (checklistForm) checklistForm.addEventListener("submit", event => this.addChecklistItem(event, project));
    if (projectTaskForm) projectTaskForm.addEventListener("submit", event => this.addProjectTask(event, project));
    if (noteForm) noteForm.addEventListener("submit", event => this.addNote(event, project));
    if (attachmentForm) attachmentForm.addEventListener("submit", event => this.addAttachment(event, project));
    container.querySelectorAll("[data-check-toggle]").forEach(input => input.addEventListener("change", () => this.toggleChecklist(project, input.dataset.checkToggle)));
    container.querySelectorAll("[data-check-edit]").forEach(button => button.addEventListener("click", () => this.editChecklist(project, button.dataset.checkEdit)));
    container.querySelectorAll("[data-check-delete]").forEach(button => button.addEventListener("click", () => this.deleteChecklist(project, button.dataset.checkDelete)));
    container.querySelectorAll("[data-milestone-row]").forEach(row => {
      row.addEventListener("dragstart", event => event.dataTransfer.setData("text/plain", row.dataset.milestoneRow));
      row.addEventListener("dragover", event => event.preventDefault());
      row.addEventListener("drop", event => this.reorderMilestone(event, project, row.dataset.milestoneRow));
    });
    container.querySelectorAll("[data-project-task-toggle]").forEach(input => input.addEventListener("change", () => this.toggleProjectTask(project, input.dataset.projectTaskToggle)));
    container.querySelectorAll("[data-project-task-edit]").forEach(button => button.addEventListener("click", () => this.editProjectTask(project, button.dataset.projectTaskEdit)));
    container.querySelectorAll("[data-project-task-delete]").forEach(button => button.addEventListener("click", () => this.deleteProjectTask(project, button.dataset.projectTaskDelete)));
    container.querySelectorAll("[data-note-delete]").forEach(button => button.addEventListener("click", () => this.deleteNote(project, button.dataset.noteDelete)));
    container.querySelectorAll("[data-attachment-delete]").forEach(button => button.addEventListener("click", () => this.deleteAttachment(project, button.dataset.attachmentDelete)));
    const closeButton = document.getElementById("closeProjectAction");
    const reopenButton = document.getElementById("reopenProjectAction");
    if (closeButton) closeButton.addEventListener("click", () => this.closeProject(project));
    if (reopenButton) reopenButton.addEventListener("click", () => this.reopenProject(project));
    document.getElementById("deleteProjectAction").addEventListener("click", () => this.deleteProject(project));
  }

  /** Opens the project detail drawer. */
  openProjectDetail(id) {
    this.selectedProjectId = id;
    this.renderProjectDetail(id);
    this.dom.projectDetail.classList.add("open");
    this.dom.appShell.classList.add("detail-open");
    this.dom.appShell.classList.toggle("detail-collapsed", this.detailCollapsed);
    this.dom.projectDetail.setAttribute("aria-hidden", "false");
  }

  /** Closes the project detail drawer. */
  closeProjectDetail() {
    this.dom.projectDetail.classList.remove("open");
    this.dom.appShell.classList.remove("detail-open", "detail-collapsed");
    this.dom.projectDetail.setAttribute("aria-hidden", "true");
  }

  /** Collapses or expands the inspector panel without closing the project. */
  toggleDetailCollapse() {
    this.detailCollapsed = !this.detailCollapsed;
    this.dom.projectDetail.classList.toggle("collapsed", this.detailCollapsed);
    this.dom.appShell.classList.toggle("detail-collapsed", this.detailCollapsed);
    this.dom.detailCollapseBtn.textContent = this.detailCollapsed ? "›" : "‹";
    this.dom.detailCollapseBtn.title = this.detailCollapsed ? "展開" : "收合";
  }

  /** Pins the inspector panel so it behaves like a fixed workspace companion. */
  toggleDetailPin() {
    this.detailPinned = !this.detailPinned;
    this.dom.projectDetail.classList.toggle("pinned", this.detailPinned);
    this.dom.detailPinBtn.classList.toggle("active", this.detailPinned);
    this.dom.detailPinBtn.title = this.detailPinned ? "取消固定" : "固定";
  }

  /** Renders all project detail panels. */
  renderProjectDetail(id) {
    const project = this.state.projects.find(item => item.id === id);
    if (!project) {
      this.closeProjectDetail();
      return;
    }
    this.dom.detailCode.textContent = project.code;
    this.dom.detailName.textContent = project.name;
    this.dom.detailType.textContent = project.type;
    this.dom.detailStatus.innerHTML = this.statusBadge(project.status);
    this.dom.projectDetail.classList.toggle("collapsed", this.detailCollapsed);
    this.dom.projectDetail.classList.toggle("pinned", this.detailPinned);
    this.dom.detailCollapseBtn.textContent = this.detailCollapsed ? "›" : "‹";
    this.dom.detailContent.innerHTML = `
      ${this.renderDetailTabs()}
      <div class="inspector-tab-panel">${this.renderCurrentDetailTab(project)}</div>
      ${this.renderDetailActions(project)}
    `;
    this.bindDetailEvents(project.id);
  }

  /** Returns inspector tab buttons. */
  renderDetailTabs() {
    const tabs = [
      ["basic", "📄 基本資料"],
      ["tasks", "☑ 工作事項"],
      ["notes", "📝 備註"],
      ["attachments", "📎 附件"],
      ["timeline", "📅 Timeline"]
    ];
    return `<div class="inspector-tabs">${tabs.map(([id, label]) => `<button class="${this.detailTab === id ? "active" : ""}" data-detail-tab="${id}">${label}</button>`).join("")}</div>`;
  }

  /** Returns the currently selected inspector tab content. */
  renderCurrentDetailTab(project) {
    if (this.detailTab === "basic") return this.renderBasicInfo(project);
    if (this.detailTab === "notes") return this.renderNotes(project);
    if (this.detailTab === "attachments") return this.renderAttachments(project);
    if (this.detailTab === "timeline") return this.renderTimeline(project);
    return this.renderChecklist(project);
  }

  /** Returns the persistent inspector action area. */
  renderDetailActions(project) {
    return `
      <div class="detail-actions">
        ${project.status === "Completed" ? `<button class="primary-button" id="reopenProjectAction">重新開啟</button>` : `<button class="danger-button" id="closeProjectAction">Close Project</button>`}
        <button class="danger-button" id="deleteProjectAction">🗑 刪除</button>
      </div>
    `;
  }

  /** Returns the project basic information HTML with editable code and status. */
  renderBasicInfo(project) {
    const statusOptions = this.state.statuses.map(status => `<option value="${this.escape(status.id)}" ${project.status === status.id ? "selected" : ""}>${this.escape(status.name)}</option>`).join("");
    const fields = [
      ["案件名稱", project.name],
      ["客戶", project.client],
      ["聯絡人", project.contact || "-"],
      ["電話", project.phone || "-"],
      ["Email", project.email || "-"],
      ["負責顧問", project.owner],
      ["開始日", this.formatDate(project.startDate)],
      ["截止日", this.formatDate(project.dueDate)],
      ["目前狀態", this.getStatus(project.status).name]
    ];
    return `
      <section class="inspector-section">
        <form class="detail-edit-form" data-update-project-meta>
          <label>案件編號<input name="code" value="${this.escape(project.code)}" required></label>
          <label>目前狀態<select name="status">${statusOptions}</select></label>
          <button class="primary-button">更新</button>
        </form>
        <div class="info-grid">${fields.map(([label, value]) => `<div class="info-card"><small>${label}</small><strong>${this.escape(value)}</strong></div>`).join("")}</div>
      </section>`;
  }

  /** Returns the checklist panel HTML. */
  renderChecklist(project) {
    return `
      <section class="inspector-section">
        <form class="mini-form" data-add-checklist><input name="title" placeholder="新增工作事項" required><button class="primary-button">新增</button></form>
        <div class="stack-list">${project.checklist.map(item => `
          <div class="stack-item">
            <label><input type="checkbox" data-check-toggle="${item.id}" ${item.done ? "checked" : ""}> <span>${this.escape(item.title)}</span></label>
            <div class="task-actions"><button data-check-edit="${item.id}">改</button><button data-check-delete="${item.id}">×</button></div>
          </div>`).join("")}</div>
      </section>`;
  }

  /** Returns the daily notes panel HTML. */
  renderNotes(project) {
    return `
      <section class="inspector-section">
        <form class="mini-form note-form" data-add-note><input name="date" type="date" value="${this.today()}" required><input name="text" placeholder="例如：今天收到天然氣資料" required><button class="primary-button">新增</button></form>
        <div class="stack-list">${project.notes.map(note => `
          <div class="stack-item"><div><strong>${this.formatDate(note.date)} ${note.time}</strong><p>${this.escape(note.text)}</p></div><button class="icon-button" data-note-delete="${note.id}">×</button></div>`).join("") || "<p>尚無備註。</p>"}</div>
      </section>`;
  }

  /** Returns the attachment panel HTML. */
  renderAttachments(project) {
    return `
      <section class="inspector-section">
        <form class="form-grid" data-add-attachment>
          <input name="name" placeholder="附件名稱" required>
          <input name="description" placeholder="附件說明">
          <input name="link" placeholder="附件連結">
          <button class="primary-button">新增附件</button>
        </form>
        <div class="stack-list" style="margin-top:12px">${project.attachments.map(file => `
          <div class="stack-item"><div><strong>${this.escape(file.name)}</strong><p>${this.escape(file.description)} ${file.link ? ` · ${this.escape(file.link)}` : ""}</p></div><button class="icon-button" data-attachment-delete="${file.id}">×</button></div>`).join("") || "<p>尚無附件。</p>"}</div>
      </section>`;
  }

  /** Returns the timeline panel HTML. */
  renderTimeline(project) {
    return `
      <section class="inspector-section">
        <div class="timeline">${project.timeline.map(item => `
          <div class="timeline-item"><strong>${item.done ? "✓ " : ""}${this.escape(item.title)}</strong><p>${item.date ? this.formatDate(item.date) : "待安排"}</p></div>`).join("")}</div>
      </section>`;
  }

  /** Attaches event listeners inside the project detail drawer. */
  bindDetailEvents(projectId) {
    const project = this.state.projects.find(item => item.id === projectId);
    this.dom.detailContent.querySelectorAll("[data-detail-tab]").forEach(button => button.addEventListener("click", () => {
      this.detailTab = button.dataset.detailTab;
      this.renderProjectDetail(projectId);
    }));
    const metaForm = this.dom.detailContent.querySelector("[data-update-project-meta]");
    const checklistForm = this.dom.detailContent.querySelector("[data-add-checklist]");
    const noteForm = this.dom.detailContent.querySelector("[data-add-note]");
    const attachmentForm = this.dom.detailContent.querySelector("[data-add-attachment]");
    if (metaForm) metaForm.addEventListener("submit", event => this.updateProjectMeta(event, project));
    if (checklistForm) checklistForm.addEventListener("submit", event => this.addChecklistItem(event, project));
    this.dom.detailContent.querySelectorAll("[data-check-toggle]").forEach(input => input.addEventListener("change", () => this.toggleChecklist(project, input.dataset.checkToggle)));
    this.dom.detailContent.querySelectorAll("[data-check-edit]").forEach(button => button.addEventListener("click", () => this.editChecklist(project, button.dataset.checkEdit)));
    this.dom.detailContent.querySelectorAll("[data-check-delete]").forEach(button => button.addEventListener("click", () => this.deleteChecklist(project, button.dataset.checkDelete)));
    if (noteForm) noteForm.addEventListener("submit", event => this.addNote(event, project));
    this.dom.detailContent.querySelectorAll("[data-note-delete]").forEach(button => button.addEventListener("click", () => this.deleteNote(project, button.dataset.noteDelete)));
    if (attachmentForm) attachmentForm.addEventListener("submit", event => this.addAttachment(event, project));
    this.dom.detailContent.querySelectorAll("[data-attachment-delete]").forEach(button => button.addEventListener("click", () => this.deleteAttachment(project, button.dataset.attachmentDelete)));
    const closeButton = document.getElementById("closeProjectAction");
    const reopenButton = document.getElementById("reopenProjectAction");
    if (closeButton) closeButton.addEventListener("click", () => this.closeProject(project));
    if (reopenButton) reopenButton.addEventListener("click", () => this.reopenProject(project));
    document.getElementById("deleteProjectAction").addEventListener("click", () => this.deleteProject(project));
  }

  /** Updates editable project code and status from the detail page. */
  updateProjectMeta(event, project) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (this.isCodeDuplicate(data.code, project.id)) {
      this.toast("案件編號已存在。");
      return;
    }
    const previousStatus = project.status;
    const previousCode = project.code;
    project.code = data.code.trim();
    project.status = data.status;
    if (previousStatus !== project.status) {
      this.addActivityLog(project, "status_changed", "修改案件狀態", `${this.getStatus(previousStatus).name} → ${this.getStatus(project.status).name}`, { from: previousStatus, to: project.status });
    }
    if (previousCode !== project.code) {
      this.addActivityLog(project, "project_updated", "修改案件資料", `案件編號：${previousCode} → ${project.code}`, { field: "code", from: previousCode, to: project.code });
    }
    if (project.status !== "Completed") project.completedDate = "";
    if (project.status === "Completed" && !project.completedDate) project.completedDate = this.today();
    this.save();
    this.renderAll();
  }

  /** Updates project finance fields from the full project detail page. */
  updateProjectFinance(event, project) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    const previous = {
      totalAmount: this.toNumber(project.totalAmount),
      receivedAmount: this.toNumber(project.receivedAmount),
      unreceivedAmount: this.toNumber(project.unreceivedAmount)
    };
    project.totalAmount = this.toNumber(data.totalAmount);
    project.receivedAmount = this.toNumber(data.receivedAmount);
    project.unreceivedAmount = this.toNumber(data.unreceivedAmount);
    const changes = [
      ["專案總額", previous.totalAmount, project.totalAmount],
      ["已收金額", previous.receivedAmount, project.receivedAmount],
      ["未收金額", previous.unreceivedAmount, project.unreceivedAmount]
    ].filter(([, from, to]) => from !== to);
    if (changes.length) {
      const description = changes.map(([label, from, to]) => `${label}：${this.formatCurrency(from)} → ${this.formatCurrency(to)}`).join("；");
      this.addActivityLog(project, "project_updated", "修改案件資料", description, { fields: changes.map(([label]) => label) });
    }
    this.save();
    this.renderAll();
  }

  /** Updates project progress from checklist completion. */
  updateProgress(project) {
    if (!project.checklist.length) project.progress = 0;
    else project.progress = Math.round(project.checklist.filter(item => item.done).length / project.checklist.length * 100);
  }

  /** Adds a checklist item to a project. */
  addChecklistItem(event, project) {
    event.preventDefault();
    const title = new FormData(event.target).get("title");
    const milestone = { id: this.uid(), title, done: false };
    project.checklist.push(milestone);
    this.addActivityLog(project, "milestone_created", "新增案件流程", `新增流程：${title}`, { milestoneId: milestone.id });
    this.updateProgress(project);
    this.save();
    this.renderAll();
  }

  /** Toggles checklist completion. */
  toggleChecklist(project, id) {
    const item = project.checklist.find(task => task.id === id);
    item.done = !item.done;
    this.addActivityLog(project, item.done ? "milestone_completed" : "milestone_reopened", item.done ? "完成案件流程" : "重新開啟案件流程", `${item.done ? "完成流程" : "重新開啟流程"}：${item.title}`, { milestoneId: item.id });
    this.updateProgress(project);
    this.save();
    this.renderAll();
  }

  /** Edits a checklist item title. */
  editChecklist(project, id) {
    const item = project.checklist.find(task => task.id === id);
    const next = prompt("修改工作事項", item.title);
    if (!next) return;
    item.title = next.trim();
    this.save();
    this.renderAll();
  }

  /** Deletes a checklist item. */
  deleteChecklist(project, id) {
    const item = project.checklist.find(task => task.id === id);
    project.checklist = project.checklist.filter(task => task.id !== id);
    if (item) this.addActivityLog(project, "milestone_deleted", "刪除項目", `刪除流程：${item.title}`, { milestoneId: id });
    this.updateProgress(project);
    this.save();
    this.renderAll();
  }

  /** Reorders milestone rows after drag and drop. */
  reorderMilestone(event, project, targetId) {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === targetId) return;
    const sourceIndex = project.checklist.findIndex(item => item.id === sourceId);
    const targetIndex = project.checklist.findIndex(item => item.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = project.checklist.splice(sourceIndex, 1);
    project.checklist.splice(targetIndex, 0, moved);
    this.save();
    this.renderAll();
  }

  /** Adds a project-level task separated from milestones. */
  addProjectTask(event, project) {
    event.preventDefault();
    const now = new Date();
    const title = new FormData(event.target).get("title");
    const task = {
      id: this.uid(),
      title,
      done: false,
      date: this.today(),
      time: now.toTimeString().slice(0, 5)
    };
    this.getProjectTasks(project).unshift(task);
    this.addActivityLog(project, "task_created", "新增工作", `新增工作：${title}`, { taskId: task.id });
    this.save();
    this.renderAll();
  }

  /** Toggles a project-level task as done or undone. */
  toggleProjectTask(project, id) {
    const task = this.getProjectTasks(project).find(item => item.id === id);
    if (!task) return;
    task.done = !task.done;
    if (task.done) {
      task.date = this.today();
      task.time = new Date().toTimeString().slice(0, 5);
    }
    this.addActivityLog(project, task.done ? "task_completed" : "task_reopened", task.done ? "完成工作" : "重新開啟工作", `${task.done ? "完成工作" : "重新開啟工作"}：${task.title}`, { taskId: task.id });
    this.save();
    this.renderAll();
  }

  /** Edits a project-level task title. */
  editProjectTask(project, id) {
    const task = this.getProjectTasks(project).find(item => item.id === id);
    if (!task) return;
    const next = prompt("修改工作事項", task.title);
    if (!next) return;
    task.title = next.trim();
    this.save();
    this.renderAll();
  }

  /** Deletes a project-level task. */
  deleteProjectTask(project, id) {
    const task = this.getProjectTasks(project).find(item => item.id === id);
    project.tasks = this.getProjectTasks(project).filter(item => item.id !== id);
    if (task) this.addActivityLog(project, "task_deleted", "刪除項目", `刪除工作：${task.title}`, { taskId: id });
    this.save();
    this.renderAll();
  }

  /** Adds a timestamped daily note. */
  addNote(event, project) {
    event.preventDefault();
    const now = new Date();
    const data = Object.fromEntries(new FormData(event.target).entries());
    const note = { id: this.uid(), date: data.date, time: now.toTimeString().slice(0, 5), text: data.text };
    project.notes.unshift(note);
    this.addActivityLog(project, "note_created", "新增備註", this.truncate(data.text), { noteId: note.id });
    this.save();
    this.renderAll();
  }

  /** Deletes a daily note. */
  deleteNote(project, id) {
    const note = project.notes.find(note => note.id === id);
    project.notes = project.notes.filter(note => note.id !== id);
    if (note) this.addActivityLog(project, "note_deleted", "刪除項目", `刪除備註：${this.truncate(note.text)}`, { noteId: id });
    this.save();
    this.renderAll();
  }

  /** Adds an attachment record. */
  addAttachment(event, project) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    const attachment = { id: this.uid(), ...data };
    project.attachments.unshift(attachment);
    this.addActivityLog(project, "attachment_created", "新增附件", `新增附件：${data.name}`, { attachmentId: attachment.id });
    this.save();
    this.renderAll();
  }

  /** Deletes an attachment record. */
  deleteAttachment(project, id) {
    const attachment = project.attachments.find(file => file.id === id);
    project.attachments = project.attachments.filter(file => file.id !== id);
    if (attachment) this.addActivityLog(project, "attachment_deleted", "刪除項目", `刪除附件：${attachment.name}`, { attachmentId: id });
    this.save();
    this.renderAll();
  }

  /** Renders the custom status management panel. */
  renderStatusManager() {
    this.dom.statusList.innerHTML = this.state.statuses.map(status => {
      const used = this.state.projects.some(project => project.status === status.id);
      const canDelete = !used && !status.locked;
      return `
        <div class="status-manager-item">
          <span class="status-pill" style="background:${status.color}">${this.escape(status.name)}</span>
          <input value="${this.escape(status.name)}" data-status-name="${status.id}" ${status.locked ? "disabled" : ""}>
          <button data-status-save="${status.id}" ${status.locked ? "disabled" : ""}>修改</button>
          <button data-status-delete="${status.id}" ${canDelete ? "" : "disabled"}>刪除</button>
        </div>`;
    }).join("");
    this.dom.statusList.querySelectorAll("[data-status-save]").forEach(button => button.addEventListener("click", () => this.renameStatus(button.dataset.statusSave)));
    this.dom.statusList.querySelectorAll("[data-status-delete]").forEach(button => button.addEventListener("click", () => this.deleteStatus(button.dataset.statusDelete)));
  }

  /** Adds one custom status. */
  addStatus(event) {
    event.preventDefault();
    const name = this.dom.statusNameInput.value.trim();
    if (!name) return;
    if (this.state.statuses.some(status => status.name === name || status.id === name)) {
      this.toast("狀態名稱已存在。");
      return;
    }
    this.state.statuses.push({ id: name, name, color: this.colorForStatus(name, this.state.statuses.length), locked: false });
    this.dom.statusNameInput.value = "";
    this.save();
    this.renderAll();
  }

  /** Renames an unused or custom status while keeping project compatibility. */
  renameStatus(statusId) {
    const status = this.state.statuses.find(item => item.id === statusId);
    const input = [...this.dom.statusList.querySelectorAll("[data-status-name]")].find(item => item.dataset.statusName === statusId);
    const name = input.value.trim();
    if (!status || !name) return;
    if (this.state.statuses.some(item => item.id !== statusId && item.name === name)) {
      this.toast("狀態名稱已存在。");
      return;
    }
    status.name = name;
    this.save();
    this.renderAll();
  }

  /** Deletes a status only when no project is using it. */
  deleteStatus(statusId) {
    if (this.state.projects.some(project => project.status === statusId)) {
      this.toast("此狀態已有案件使用，無法刪除。");
      return;
    }
    this.state.statuses = this.state.statuses.filter(status => status.id !== statusId || status.locked);
    this.save();
    this.renderAll();
  }

  /** Closes a project after confirmation and moves it to history. */
  async closeProject(project) {
    const ok = await this.confirm("Close Project", "確定要結案嗎？狀態將改為 Completed，並自動填入今天為完成日期。");
    if (!ok) return;
    const previousStatus = project.status;
    project.status = "Completed";
    this.addActivityLog(project, "project_closed", "專案結案", "專案已結案", { from: previousStatus, to: project.status });
    project.progress = 100;
    project.completedDate = this.today();
    project.checklist.forEach(item => item.done = true);
    project.timeline.forEach(item => {
      item.done = true;
      if (!item.date) item.date = this.today();
    });
    this.projectTab = "history";
    this.save();
    this.renderAll();
  }

  /** Reopens a completed project and returns it to active projects. */
  reopenProject(project) {
    const previousStatus = project.status;
    project.status = "In Progress";
    project.completedDate = "";
    this.addActivityLog(project, "project_reopened", "重新開啟案件", "專案已重新開啟", { from: previousStatus, to: project.status });
    this.projectTab = "active";
    this.save();
    this.renderAll();
  }

  /** Deletes a project after confirmation and refreshes every dependent view. */
  async deleteProject(project) {
    const ok = await this.confirm("刪除專案", "確定要刪除此案件？\n此動作無法復原。", "確認刪除");
    if (!ok) return;
    this.state.projects = this.state.projects.filter(item => item.id !== project.id);
    if (this.selectedProjectId === project.id) this.selectedProjectId = null;
    this.closeProjectDetail();
    this.save();
    this.switchView("projects");
    this.renderAll();
  }

  /** Shows a confirmation dialog and resolves the selected answer. */
  confirm(title, message, okLabel = "確認") {
    this.dom.confirmTitle.textContent = title;
    this.dom.confirmMessage.textContent = message;
    this.dom.confirmOk.textContent = okLabel;
    this.dom.confirmDialog.showModal();
    return new Promise(resolve => {
      this.confirmResolver = resolve;
    });
  }

  /** Resolves the current confirmation dialog. */
  resolveConfirm(value) {
    this.dom.confirmDialog.close();
    if (this.confirmResolver) this.confirmResolver(value);
    this.confirmResolver = null;
  }

  /** Shows the required auto-save toast near the top right. */
  autoSaveToast() {
    clearTimeout(this.saveToastTimer);
    this.toast("已自動儲存", 2000);
  }

  /** Shows a temporary toast message. */
  toast(message, duration = 2400) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    this.dom.toastHost.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const app = new ESGApp();
  app.init();
});
