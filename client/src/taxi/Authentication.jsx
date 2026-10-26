import React, { useState } from "react";
import Login from "./Login";
import Register from "./Register";
import { IconText } from "./TaxiIcon";

// Login / registration switch shown in the install gate's browser shell.
export const Authentication = () => {
  const [wantsLogin, setWantsLogin] = useState(true);

  // On Android the keyboard shrinks the visual viewport after focus. The
  // browser's own scroll-into-view often lands the field under the keyboard,
  // so wait for the resize and centre the field inside the scroll container.
  const keepFieldVisible = (event) => {
    const field = event.target;
    if (!field?.matches?.("input, select, textarea")) return;
    const centre = () => field.scrollIntoView?.({ block: "center", behavior: "smooth" });
    // Once right away and once after the keyboard animation settles
    window.setTimeout(centre, 320);
    window.setTimeout(centre, 800);
  };

  return (
    <div
      className="auth-scroll w-full h-full overflow-y-auto overscroll-contain"
      onFocusCapture={keepFieldVisible}
    >
      {/* min-h-full + justify-center centres a short form, but lets the
          wrapper grow with the content (unlike items-center, which clips the
          top of a tall form when the keyboard is open) */}
      <div className="mx-auto flex min-h-full w-full max-w-[34rem] flex-col justify-center px-4 py-4">
        {wantsLogin ? (
          <Login setUserWantsToLogin={setWantsLogin} />
        ) : (
          <Register setUserWantsToLogin={setWantsLogin} />
        )}
        <div className="mt-4 text-center text-[1.2rem] text-secondary-text">
          <IconText>🚕 Бомбила — такси без посредников</IconText>
        </div>
      </div>
    </div>
  );
};

export default Authentication;
