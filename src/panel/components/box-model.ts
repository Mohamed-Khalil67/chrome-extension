import { BoxDimensions } from '../../core/models/debugger';

export class BoxModelDiagram {
  static render(dimensions: BoxDimensions, container: HTMLElement): void {
    container.innerHTML = `
      <div class="box-model-container">
        <div class="box-layer margin-layer">
          <div class="box-label">margin</div>
          <div class="box-val top">${dimensions.margin.top}</div>
          <div class="box-val left">${dimensions.margin.left}</div>
          <div class="box-val right">${dimensions.margin.right}</div>
          <div class="box-val bottom">${dimensions.margin.bottom}</div>

          <div class="box-layer border-layer">
            <div class="box-label">border</div>
            <div class="box-val top">${dimensions.border.top}</div>
            <div class="box-val left">${dimensions.border.left}</div>
            <div class="box-val right">${dimensions.border.right}</div>
            <div class="box-val bottom">${dimensions.border.bottom}</div>

            <div class="box-layer padding-layer">
              <div class="box-label">padding</div>
              <div class="box-val top">${dimensions.padding.top}</div>
              <div class="box-val left">${dimensions.padding.left}</div>
              <div class="box-val right">${dimensions.padding.right}</div>
              <div class="box-val bottom">${dimensions.padding.bottom}</div>

              <div class="box-layer content-layer">
                <div class="content-dimensions">
                  ${dimensions.width} &times; ${dimensions.height}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
