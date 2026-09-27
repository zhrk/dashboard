const LOG_LIMIT = 1000;

document.addEventListener('alpine:init', () => {
  Alpine.data('dashboard', () => ({
    apps: [],
    selected: null,
    logs: [],
    follow: true,

    get app() {
      return this.apps.find((a) => a.name === this.selected);
    },

    async init() {
      this.apps = await (await fetch('/apps')).json();
      this.select(this.apps[0]?.name);

      const events = new EventSource('/events');

      events.addEventListener('status', async () => {
        this.apps = await (await fetch('/apps')).json();
      });

      events.addEventListener('log', ({ data }) => {
        const log = JSON.parse(data);
        if (log.app === this.selected) this.append([log]);
      });

      // The dashboard itself is managed by the process manager: once the
      // connection drops (restart/update), wait for the server and reload
      events.onerror = async () => {
        events.close();
        while (!(await fetch('/apps').then((r) => r.ok, () => false))) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        location.reload();
      };
    },

    async select(name) {
      this.selected = name;
      this.logs = [];
      this.follow = true;
      if (!name) return;

      const logs = await (await fetch(`/apps/${name}/logs?limit=${LOG_LIMIT}`)).json();
      if (name !== this.selected) return;

      // Live entries may have arrived while fetching; keep the newer ones after the buffer
      const live = this.logs;
      this.logs = [];
      this.append(logs);
      this.append(live);
    },

    append(entries) {
      const last = this.logs.at(-1)?.id ?? -1;
      this.logs.push(...entries.filter((e) => e.id > last));
      this.logs.splice(0, this.logs.length - LOG_LIMIT);
      if (this.follow) this.$nextTick(() => (this.$refs.logs.scrollTop = this.$refs.logs.scrollHeight));
    },

    control(action) {
      fetch(`/apps/${this.selected}/${action}`, { method: 'POST' });
    },

    async clear() {
      await fetch(`/apps/${this.selected}/logs`, { method: 'DELETE' });
      this.logs = [];
    },
  }));
});
