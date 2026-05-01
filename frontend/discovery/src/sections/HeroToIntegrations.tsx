import ScrollFrameCanvas from "../components/ScrollFrameCanvas";

const FRAME_COUNT = 75;

export default function HeroToIntegrations() {
  return (
    <ScrollFrameCanvas
      framePath="/discovery/frames/hero-to-integrations/desktop"
      frameCount={FRAME_COUNT}
      scrollHeightVh={200}
    />
  );
}
