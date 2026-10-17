declare module 'cm-chessboard' {
  export const COLOR: { readonly white: string; readonly black: string };
  export const INPUT_EVENT_TYPE: {
    readonly moveInputStarted: string;
    readonly validateMoveInput: string;
  };
  export const PIECES_FILE_TYPE: { readonly svgSprite: string };

  export interface MoveInputEvent {
    readonly type: string;
    readonly squareFrom?: string;
    readonly squareTo?: string;
  }

  export class Chessboard {
    constructor(context: HTMLElement, props?: Record<string, unknown>);
    enableMoveInput(handler: (event: MoveInputEvent) => boolean, color?: string): void;
    disableMoveInput(): void;
    setPosition(fen: string, animated?: boolean): Promise<void>;
    setOrientation(color: string, animated?: boolean): Promise<void>;
    destroy(): void;
  }
}
