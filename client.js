window.__ModuleLoader__.load({
  id: 'dsh-plugin-provider-tunnel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const text = { color: 'var(--dsw-alias-label-primary)' };
    const muted = { color: 'var(--dsw-alias-label-secondary)' };
    const title = { ...text, fontSize: 14, fontWeight: 600 };
    const small = { ...muted, fontSize: 12, lineHeight: 1.6 };
    const input = {
      width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontFamily: 'inherit',
    };
    const button = {
      padding: '7px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
      fontSize: 13, cursor: 'pointer',
    };
    const card = {
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 16,
      background: 'var(--dsw-alias-bg-layer-1)', display: 'grid', gap: 12, maxWidth: 720,
    };
    const row = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' };

    // 原生 indeterminate 只能通过 DOM 属性设置，React 不接管。
    function Check({ checked, indeterminate, onChange }) {
      const ref = useRef(null);
      useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate === true && !checked;
      }, [checked, indeterminate]);
      return h('input', { ref, type: 'checkbox', checked, onChange });
    }

    function Section() {
      const [state, setState] = useState(null);
      const [proxy, setProxy] = useState('');
      const [selected, setSelected] = useState([]);
      const [expanded, setExpanded] = useState([]);
      const [message, setMessage] = useState(null);
      const [busy, setBusy] = useState(false);

      const apply = (body) => {
        setState(body);
        setProxy(body.vpnProxy ?? '');
        const groups = body.groups ?? [];
        const ids = Array.isArray(body.vpnModelIds) ? body.vpnModelIds : [];
        // 旧配置只有厂商列表时，展开成模型列表再交给界面。
        if (ids.length > 0) {
          setSelected(ids);
          return;
        }
        const vendors = Array.isArray(body.vpnProviders) ? body.vpnProviders : [];
        const expanded = groups
          .flatMap((group) => group.models)
          .filter((id) => vendors.some((vendor) => id === vendor || id.startsWith(`${vendor}/`)));
        setSelected(expanded);
      };

      const load = async () => {
        const response = await fetch('/provider-tunnel/state', { headers: { accept: 'application/json' } });
        apply(await response.json());
      };

      useEffect(() => {
        load().catch((error) => setMessage({ kind: 'error', text: String(error) }));
      }, []);

      const has = (id) => selected.includes(id);
      const isOpen = (provider) => expanded.includes(provider);
      const toggleOpen = (provider) => setExpanded((current) => (
        current.includes(provider) ? current.filter((item) => item !== provider) : [...current, provider]
      ));
      const pickedIn = (group) => group.models.filter(has).length;

      const setMany = (ids, on) => {
        setMessage(null);
        setSelected((current) => {
          const next = new Set(current);
          for (const id of ids) { if (on) next.add(id); else next.delete(id); }
          return [...next];
        });
      };

      const save = async () => {
        setBusy(true);
        setMessage(null);
        try {
          const response = await fetch('/provider-tunnel/vpnProxy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vpnProxy: proxy, vpnProviders: [], vpnModelIds: selected }),
          });
          const body = await response.json();
          if (!body.ok) setMessage({ kind: 'error', text: body.error ?? '保存失败' });
          else setMessage({ kind: 'ok', text: '已保存，转发器已按新配置重启' });
          setTimeout(() => { load().catch(() => {}); }, 1200);
        } catch (error) {
          setMessage({ kind: 'error', text: String(error) });
        } finally {
          setBusy(false);
        }
      };

      return h('div', { style: { display: 'grid', gap: 14 } },
        h('div', { style: title }, 'Provider 隧道'),

        h('div', { style: card },
          h('div', { style: { display: 'grid', gap: 6 } },
            h('div', { style: title }, 'VPN 代理地址'),
            h('input', {
              style: input, value: proxy, spellCheck: false, placeholder: '127.0.0.1:7897',
              onChange: (event) => { setProxy(event.target.value); setMessage(null); },
            }),
          ),

          h('div', { style: { display: 'grid', gap: 8 } },
            h('div', { style: title }, '走 VPN 的模型'),
            h('div', { style: small }, '勾厂商 = 整组选中；取消个别模型只影响它自己。'),
            ...(state?.groups ?? []).map((group) => {
              const picked = pickedIn(group);
              const all = picked === group.models.length;
              const open = isOpen(group.provider);
              return h('div', {
                key: group.provider,
                style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' },
              },
                h('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer' },
                  onClick: () => toggleOpen(group.provider),
                },
                  h('span', { style: { ...muted, width: 12, fontSize: 11, userSelect: 'none' } }, open ? '▾' : '▸'),
                  h('label', { style: { ...row, fontWeight: 600, flex: 1, margin: 0 }, onClick: (event) => event.stopPropagation() },
                    h(Check, {
                      checked: all,
                      indeterminate: picked > 0 && !all,
                      onChange: () => setMany(group.models, !all),
                    }),
                    `${group.provider}（${picked}/${group.models.length}）`,
                  ),
                ),
                open ? h('div', {
                  style: { display: 'grid', gap: 4, padding: '4px 12px 12px 32px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
                },
                  ...group.models.map((id) => h('label', { key: id, style: { ...row, ...small } },
                    h(Check, { checked: has(id), onChange: () => setMany([id], !has(id)) }),
                    id,
                  )),
                ) : null,
              );
            }),
          ),

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('button', { style: button, disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
            message ? h('span', {
              style: { ...small, color: message.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' },
            }, message.text) : null,
          ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'provider-tunnel',
          order: 26,
          label: 'Provider 隧道',
        }, Section));
      },
    };
  },
});
