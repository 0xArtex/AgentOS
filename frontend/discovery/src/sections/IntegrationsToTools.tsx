import ScrollFrameCanvas from "../components/ScrollFrameCanvas";

const FRAME_COUNT = 75;

export default function IntegrationsToTools() {
  return (
    <ScrollFrameCanvas
      framePath="/discovery/frames/integrations-to-tools/desktop"
      frameCount={FRAME_COUNT}
      scrollHeightVh={200}
    />
  );
}
