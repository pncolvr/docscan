import { arrow, autoUpdate, computePosition, flip, offset, shift } from "https://cdn.jsdelivr.net/npm/@floating-ui/dom@1.6.13/+esm";

export function initializeTooltips(){
  const tooltip = document.createElement("div");
  const tooltipArrow = document.createElement("div");
  tooltip.className = "app-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.append(tooltipArrow);
  document.body.append(tooltip);

  let reference = null;
  let cleanup = null;
  let hideTimer = null;

  function hide(){
    if (hideTimer) clearTimeout(hideTimer);
    if (cleanup) cleanup();
    cleanup = null;
    reference = null;
    tooltip.classList.remove("visible");
  }

  async function update(){
    if (!reference) return;
    const result = await computePosition(reference, tooltip, {
      placement:"top",
      strategy:"fixed",
      middleware:[offset(10), flip({ padding:12 }), shift({ padding:12 }), arrow({ element:tooltipArrow, padding:8 })]
    });
    if (!reference) return;
    Object.assign(tooltip.style, { left:`${result.x}px`, top:`${result.y}px` });
    const arrowData = result.middlewareData.arrow || {};
    const side = result.placement.split("-")[0];
    tooltipArrow.style.left = arrowData.x == null ? "" : `${arrowData.x}px`;
    tooltipArrow.style.top = arrowData.y == null ? "" : `${arrowData.y}px`;
    tooltipArrow.style.right = "";
    tooltipArrow.style.bottom = "";
    if (side === "top") tooltipArrow.style.bottom = "-4px";
    if (side === "bottom") tooltipArrow.style.top = "-4px";
    if (side === "left") tooltipArrow.style.right = "-4px";
    if (side === "right") tooltipArrow.style.left = "-4px";
  }

  function show(element){
    const content = element.dataset.tooltip || "";
    if (!content) return;
    if (reference !== element) hide();
    reference = element;
    tooltip.textContent = content;
    tooltip.append(tooltipArrow);
    tooltip.classList.add("visible");
    cleanup = autoUpdate(reference, tooltip, update);
    update();
  }

  document.querySelectorAll("[data-i18n-tooltip]").forEach(element => {
    element.addEventListener("mouseenter", () => show(element));
    element.addEventListener("mouseleave", hide);
    element.addEventListener("focusin", () => show(element));
    element.addEventListener("focusout", hide);
  });

  return {
    refresh(){
      if (!reference) return;
      tooltip.textContent = reference.dataset.tooltip || "";
      tooltip.append(tooltipArrow);
      update();
    },
    showOnceFor(element, duration){
      show(element);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, duration);
    }
  };
}
