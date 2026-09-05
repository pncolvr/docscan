import { arrow, autoUpdate, computePosition, flip, offset, shift } from "https://cdn.jsdelivr.net/npm/@floating-ui/dom@1.6.13/+esm";

function createTooltip(layer){
  const element = document.createElement("div");
  const tooltipArrow = document.createElement("div");
  element.className = `app-tooltip app-tooltip-${layer}`;
  element.setAttribute("role", "tooltip");
  element.append(tooltipArrow);
  document.body.append(element);
  return { element, tooltipArrow, reference:null, cleanup:null, hideTimer:null };
}

export function initializeTooltips(){
  const persistentTooltip = createTooltip("persistent");
  const hoverTooltip = createTooltip("hover");
  const states = new WeakMap();

  async function update(state){
    if (!state.reference) return;
    const result = await computePosition(state.reference, state.element, {
      placement:state.reference.dataset.tooltipPlacement || "top",
      strategy:"fixed",
      middleware:[offset(10), flip({ padding:12 }), shift({ padding:12 }), arrow({ element:state.tooltipArrow, padding:8 })]
    });
    if (!state.reference) return;
    Object.assign(state.element.style, { left:`${result.x}px`, top:`${result.y}px` });
    const arrowData = result.middlewareData.arrow || {};
    const side = result.placement.split("-")[0];
    state.tooltipArrow.style.left = arrowData.x == null ? "" : `${arrowData.x}px`;
    state.tooltipArrow.style.top = arrowData.y == null ? "" : `${arrowData.y}px`;
    state.tooltipArrow.style.right = "";
    state.tooltipArrow.style.bottom = "";
    if (side === "top") state.tooltipArrow.style.bottom = "-4px";
    if (side === "bottom") state.tooltipArrow.style.top = "-4px";
    if (side === "left") state.tooltipArrow.style.right = "-4px";
    if (side === "right") state.tooltipArrow.style.left = "-4px";
  }

  function hideState(state){
    if (state.hideTimer) clearTimeout(state.hideTimer);
    if (state.cleanup) state.cleanup();
    state.hideTimer = null;
    state.cleanup = null;
    state.reference = null;
    state.element.classList.remove("visible");
  }

  function showState(state, reference, content){
    if (!content) return;
    state.reference = reference;
    state.element.textContent = content;
    state.element.append(state.tooltipArrow);
    state.element.classList.add("visible");
    if (state.cleanup) state.cleanup();
    state.cleanup = autoUpdate(reference, state.element, () => update(state));
    update(state);
  }

  function setState(element, content, mode = "hover"){
    if (mode === "persistent" && persistentTooltip.hideTimer){
      clearTimeout(persistentTooltip.hideTimer);
      persistentTooltip.hideTimer = null;
    }
    states.set(element, { content, mode });
    element.dataset.tooltip = content;
    if (mode === "persistent") showState(persistentTooltip, element, content);
    if (mode === "hidden") hideState(persistentTooltip);
  }

  document.querySelectorAll("[data-i18n-tooltip]").forEach(element => {
    states.set(element, { content:element.dataset.tooltip || "", mode:"hover" });
    element.addEventListener("mouseenter", () => {
      const state = states.get(element);
      if (state?.mode === "hover") showState(hoverTooltip, element, state.content);
    });
    element.addEventListener("mouseleave", () => hideState(hoverTooltip));
  });

  return {
    refresh(){
      [persistentTooltip, hoverTooltip].forEach(state => {
        if (!state.reference) return;
        const content = states.get(state.reference)?.content || state.reference.dataset.tooltip || "";
        state.element.textContent = content;
        state.element.append(state.tooltipArrow);
        update(state);
      });
    },
    showOnceFor(element, duration){
      setState(element, element.dataset.tooltip || "", "persistent");
      if (persistentTooltip.hideTimer) clearTimeout(persistentTooltip.hideTimer);
      persistentTooltip.hideTimer = setTimeout(() => {
        setState(element, element.dataset.tooltip || "", "hover");
        hideState(persistentTooltip);
      }, duration);
    },
    showPersistent(element, content){
      setState(element, content, "persistent");
    },
    setState,
    hide(){
      hideState(persistentTooltip);
    }
  };
}
