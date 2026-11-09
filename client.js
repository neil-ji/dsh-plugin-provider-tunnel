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

    // 折角箭头用 SVG，不用字符，避免字体差异导致大小/对齐不一致。
    function Chevron({ open }) {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true,
        style: {
          flex: '0 0 auto', display: 'block',
          color: 'var(--dsw-alias-label-secondary)',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 120ms ease',
        },
      }, h('path', {
        d: 'M6 3.5 10.5 8 6 12.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }));
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
        setProxy(body.proxy ?? '');
        const groups = body.groups ?? [];
        const ids = Array.isArray(body.modelIds) ? body.modelIds : [];
        // 旧配置只有厂商列表时，展开成模型列表再交给界面。
        if (ids.length > 0) {
          setSelected(ids);
          return;
        }
        const vendors = Array.isArray(body.vendors) ? body.vendors : [];
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

      // 卡片内部再按模型 id 的厂商前缀分组（openai/... → openai），
      // 没有前缀的（zai、opencode-go 的模型）用 provider 名当组名。
      const vendorsOf = (group) => {
        const map = new Map();
        for (const id of group.models) {
          const vendor = id.includes('/') ? id.slice(0, id.indexOf('/')) : group.provider;
          if (!map.has(vendor)) map.set(vendor, []);
          map.get(vendor).push(id);
        }
        return [...map].map(([vendor, models]) => ({ vendor, models }));
      };

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
          const response = await fetch('/provider-tunnel/proxy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ proxy, modelIds: selected }),
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
            h('div', { style: title }, '路由代理地址'),
            h('input', {
              style: input, value: proxy, spellCheck: false, placeholder: '127.0.0.1:7897',
              onChange: (event) => { setProxy(event.target.value); setMessage(null); },
            }),
          ),

          h('div', { style: { display: 'grid', gap: 8 } },
            h('div', { style: title }, '经代理路由的模型'),
            ...(state?.groups ?? []).map((group) => {
              const open = isOpen(group.provider);
              const picked = pickedIn(group);
              return h('div', {
                key: group.provider,
                style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' },
              },
                h('div', {
                  style: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer', userSelect: 'none' },
                  onClick: () => toggleOpen(group.provider),
                },
                  h(Chevron, { open }),
                  h('span', { style: { ...text, fontSize: 13, fontWeight: 600, flex: 1 } }, group.provider),
                  h('span', { style: { ...muted, fontSize: 12 } }, `${picked}/${group.models.length}`),
                ),
                open ? h('div', {
                  style: { display: 'grid', gap: 10, padding: '10px 14px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
                },
                  ...vendorsOf(group).map((vendorGroup) => {
                    const vendorPicked = vendorGroup.models.filter(has).length;
                    const vendorAll = vendorPicked === vendorGroup.models.length;
                    return h('div', { key: vendorGroup.vendor, style: { display: 'grid', gap: 4 } },
                      h('label', { style: { ...row, fontWeight: 600 } },
                        h(Check, {
                          checked: vendorAll,
                          indeterminate: vendorPicked > 0 && !vendorAll,
                          onChange: () => setMany(vendorGroup.models, !vendorAll),
                        }),
                        vendorGroup.vendor,
                        h('span', { style: { ...muted, fontSize: 11, fontWeight: 400 } }, `${vendorPicked}/${vendorGroup.models.length}`),
                      ),
                      h('div', { style: { display: 'grid', gap: 4, paddingLeft: 24 } },
                        ...vendorGroup.models.map((id) => h('label', { key: id, style: { ...row, ...small } },
                          h(Check, { checked: has(id), onChange: () => setMany([id], !has(id)) }),
                          id,
                        )),
                      ),
                    );
                  }),
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
