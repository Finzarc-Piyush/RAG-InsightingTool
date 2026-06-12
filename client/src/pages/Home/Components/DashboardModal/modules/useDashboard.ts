import { useState } from "react";
import { ChartSpec } from '@/shared/schema';
import { logger } from "@/lib/logger";

interface useDashboardProps{
    onClose: () => void;
    chart: ChartSpec;
}

export const useDashboard = ({onClose, chart }:useDashboardProps) => {

    const [newDashboardName, setNewDashboardName] = useState('');
  const [selectedDashboard, setSelectedDashboard] = useState('');

  const handleAddToDashboard = () => {
    if (selectedDashboard || newDashboardName.trim()) {
      // Here you would implement the logic to add chart to dashboard
      logger.log('Adding chart to dashboard:', {
        chart,
        dashboard: selectedDashboard || newDashboardName,
        isNew: !!newDashboardName.trim()
      });
      onClose();
    }
  };

  const handleCreateNew = () => {
    setSelectedDashboard('');
    setNewDashboardName('');
  };

  return {
    setSelectedDashboard,
    newDashboardName,
    selectedDashboard,
    setNewDashboardName,
    handleAddToDashboard,
    handleCreateNew,
  };
}